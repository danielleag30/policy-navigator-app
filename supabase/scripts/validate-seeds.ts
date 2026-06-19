type SeedSource = {
  id?: string;
  discovery_urls?: unknown;
};

type SeedConfig = {
  sources?: unknown;
};

type UrlCheckResult = {
  url: string;
  status: number | "ERROR";
  ok: boolean;
  error?: string;
};

const seedConfigUrl = new URL("../config/seed-sources.json", import.meta.url);

async function readSeedConfig(): Promise<SeedConfig> {
  const contents = await Deno.readTextFile(seedConfigUrl);
  return JSON.parse(contents) as SeedConfig;
}

function collectDiscoveryUrls(config: SeedConfig): string[] {
  if (!Array.isArray(config.sources)) {
    throw new Error("seed-sources.json must contain a sources array");
  }

  return config.sources.flatMap((source: SeedSource) => {
    if (!Array.isArray(source.discovery_urls)) {
      return [];
    }

    return source.discovery_urls.filter((url): url is string => typeof url === "string");
  });
}

async function headUrl(url: string): Promise<UrlCheckResult> {
  try {
    const response = await fetch(url, { method: "HEAD" });

    return {
      url,
      status: response.status,
      ok: response.status === 200,
    };
  } catch (error) {
    return {
      url,
      status: "ERROR",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const seedConfig = await readSeedConfig();
const urls = collectDiscoveryUrls(seedConfig);
const results = await Promise.all(urls.map((url) => headUrl(url)));

for (const result of results) {
  console.log(`[${result.status}] ${result.url}`);
}

const failures = results.filter((result) => !result.ok);

if (failures.length > 0) {
  console.error(`\nSeed URL validation failed for ${failures.length} URL(s):`);

  for (const failure of failures) {
    const errorSuffix = failure.error ? ` (${failure.error})` : "";
    console.error(`${failure.url} - ${failure.status}${errorSuffix}`);
  }

  Deno.exitCode = 1;
} else {
  console.log(`\nSeed URL validation passed: ${results.length} URL(s) returned 200.`);
}
