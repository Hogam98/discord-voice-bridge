const http = require("http");
const { PassThrough } = require("stream");
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  NoSubscriberBehavior
} = require("@discordjs/voice");
const prism = require("prism-media");

const PORT = Number(process.env.PORT || 8000);
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
const BYTES_PER_FRAME = (SAMPLE_RATE * CHANNELS * 2 * FRAME_MS) / 1000;
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME);

function loadNodesFromEnv() {
  const nodes = [];
  const tokenPrefix = "FREQUENCE_";
  const tokenSuffix = "_TOKEN";

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(tokenPrefix) || !key.endsWith(tokenSuffix)) {
      continue;
    }

    const name = key.slice(tokenPrefix.length, -tokenSuffix.length).trim();
    if (!name) {
      continue;
    }

    const token = String(value || "").trim();
    const guildId = String(process.env[`${tokenPrefix}${name}_GUILD_ID`] || "").trim();
    const channelId = String(process.env[`${tokenPrefix}${name}_CHANNEL_ID`] || "").trim();

    if (!token || !guildId || !channelId) {
      throw new Error(`Incomplete configuration for FREQUENCE_${name}. Ensure TOKEN, GUILD_ID, and CHANNEL_ID are provided.`);
    }

    nodes.push({
      name,
      token,
      guildId,
      channelId,
      client: new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
      }),
      connection: null,
      queues: new Map(),
      output: new PassThrough()
    });
  }

  nodes.sort((a, b) => a.name.localeCompare(b.name));

  if (nodes.length < 2) {
    throw new Error("At least two frequencies must be configured to establish the audio bridge.");
  }

  return nodes;
}

function enqueuePcm(node, userId, chunk) {
  let state = node.queues.get(userId);
  if (!state) {
    state = { remainder: Buffer.alloc(0), frames: [], ended: false };
    node.queues.set(userId, state);
  }

  let data = state.remainder.length > 0 ? Buffer.concat([state.remainder, chunk]) : chunk;
  while (data.length >= BYTES_PER_FRAME) {
    state.frames.push(data.subarray(0, BYTES_PER_FRAME));
    data = data.subarray(BYTES_PER_FRAME);
  }
  state.remainder = data;
}

function startMeshMixer(nodes) {
  setInterval(() => {
    const incomingFrames = new Map();

    for (const sourceNode of nodes) {
      const nodeFrames = [];

      for (const [userId, state] of sourceNode.queues.entries()) {
        const frame = state.frames.shift();
        if (!frame) {
          if (state.ended) {
            sourceNode.queues.delete(userId);
          }
          continue;
        }
        nodeFrames.push(frame);
      }

      if (nodeFrames.length > 0) {
        incomingFrames.set(sourceNode.name, nodeFrames);
      }
    }

    for (const targetNode of nodes) {
      let hasAudio = false;
      const mixBuffer = new Int32Array(BYTES_PER_FRAME / 2);

      for (const [sourceName, frames] of incomingFrames.entries()) {
        if (sourceName === targetNode.name) {
          continue;
        }

        hasAudio = true;
        for (const frame of frames) {
          for (let i = 0; i < mixBuffer.length; i++) {
            mixBuffer[i] += frame.readInt16LE(i * 2);
          }
        }
      }

      if (!hasAudio) {
        targetNode.output.write(SILENCE_FRAME);
        continue;
      }

      const outFrame = Buffer.allocUnsafe(BYTES_PER_FRAME);
      for (let i = 0; i < mixBuffer.length; i++) {
        const clamped = Math.max(-32768, Math.min(32767, mixBuffer[i]));
        outFrame.writeInt16LE(clamped, i * 2);
      }
      targetNode.output.write(outFrame);
    }
  }, FRAME_MS);
}

function attachListener(node, blockedIds) {
  node.connection.receiver.speaking.on("start", (userId) => {
    if (blockedIds.has(userId)) {
      return;
    }

    const user = node.client.users.cache.get(userId);
    if (user && user.bot) {
      return;
    }

    const existing = node.queues.get(userId);
    if (existing && !existing.ended) {
      return;
    }

    const opusStream = node.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 }
    });

    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960
    });

    node.queues.set(userId, { remainder: Buffer.alloc(0), frames: [], ended: false });
    opusStream.pipe(decoder);

    decoder.on("data", (pcmChunk) => {
      enqueuePcm(node, userId, pcmChunk);
    });

    const cleanup = () => {
      const state = node.queues.get(userId);
      if (state) {
        state.ended = true;
      }
    };

    opusStream.on("end", cleanup);
    opusStream.on("error", cleanup);
    decoder.on("error", cleanup);
  });
}

async function startBridge() {
  const nodes = loadNodesFromEnv();

  await Promise.all(nodes.map((node) => node.client.login(node.token)));

  const blockedIds = new Set(nodes.map((node) => node.client.user.id));

  for (const node of nodes) {
    const guild = await node.client.guilds.fetch(node.guildId);

    node.connection = joinVoiceChannel({
      channelId: node.channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });

    player.play(createAudioResource(node.output, { inputType: StreamType.Raw }));
    node.connection.subscribe(player);

    attachListener(node, blockedIds);
  }

  startMeshMixer(nodes);

  const labels = nodes.map((n) => `Frequence ${n.name}`).join(", ");
  console.log(`Audio bridge is active across ${labels}.`);
}

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Health check server is listening on port ${PORT}.`);
});

startBridge().catch((err) => {
  console.error("Failed to start the audio bridge.", err);
  process.exit(1);
});
