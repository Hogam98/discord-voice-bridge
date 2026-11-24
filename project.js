function resolveHealthUrl() {
  if (process.env.KOYEB_HEALTH_URL) {
    return process.env.KOYEB_HEALTH_URL.trim();
  }

  if (process.env.ALL_SECRETS) {
    try {
      const secrets = JSON.parse(process.env.ALL_SECRETS);
      if (secrets && typeof secrets.KOYEB_HEALTH_URL === "string") {
        return secrets.KOYEB_HEALTH_URL.trim();
      }
    } catch (error) {
      throw new Error("Failed to parse ALL_SECRETS payload.");
    }
  }

  return "";
}

async function run() {
  const healthUrl = resolveHealthUrl();

  if (!healthUrl) {
    throw new Error("Missing KOYEB_HEALTH_URL secret.");
  }

  const response = await fetch(healthUrl, {
    method: "GET",
    headers: {
      "User-Agent": "Automation-Core-KeepAlive/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}.`);
  }

  console.log(`Health check succeeded with status ${response.status}.`);
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { run };
