export async function collectFromAdapters(registry, method, fallback = []) {
  const chunks = await Promise.all(
    registry.all().map(async (adapter) => {
      try {
        return await adapter[method]();
      } catch (error) {
        return fallbackFor(adapter.source, error, fallback);
      }
    })
  );

  return chunks.flat();
}

export async function collectRuntimeHealth(registry) {
  return Promise.all(
    registry.all().map(async (adapter) => {
      try {
        return await adapter.health();
      } catch (error) {
        return {
          source: adapter.source,
          ok: false,
          status: "offline",
          details: { error: error.message }
        };
      }
    })
  );
}

function fallbackFor(source, error, fallback) {
  if (fallback.length) return fallback;
  return [
    {
      id: `${source}:error:${Date.now()}`,
      source,
      title: error.message,
      status: "failed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { error: true }
    }
  ];
}

