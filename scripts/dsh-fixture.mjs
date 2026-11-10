import { pathToFileURL } from "node:url";
import { resolve, join, dirname } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
export const runtime = resolve(
  process.env.AGENTGAMER_DSH_RUNTIME || ".artifacts/dsh-runtime/dsh",
);
export const load = async (name) =>
  import(
    pathToFileURL(join(runtime, "node_modules", name, "lib/index.js")).href
  );
export async function fixture(tag, hostFile = resolve("dist/host.js")) {
  const { Context } = await load("@deepseek-ai/cordis");
  const ctx = new Context();
  const target = join(runtime, "agentgamer-check", tag, "host.mjs");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(hostFile, target);
  try {
    for (const name of [
      "@deepseek-ai/cordis-plugin-timer",
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-session-projection",
      "@deepseek-ai/dsh-session-query-sqlite",
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-tool-executor-native",
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-session-title",
      "@deepseek-ai/dsh-agent-loop",
      "@deepseek-ai/dsh-typert-registry",
    ]) {
      const mod = await load(name);
      await ctx.plugin(
        mod.default || mod,
        name.endsWith("session-query-sqlite")
          ? { path: ":memory:", openAt: "never" }
          : name.endsWith("system-prompt")
            ? { includeHarnessIdentity: false, includeRuntimeContext: false }
            : name.endsWith("agent-loop")
              ? { agents: [] }
              : name.endsWith("session-title")
                ? {
                    fallbackMaxWords: 5,
                    fallbackMaxBytes: 40,
                    maxTitleBytes: 80,
                  }
                : {},
      );
    }
    await ctx.plugin(await import(pathToFileURL(target).href));
    const { HistoryController } = await import(
      pathToFileURL(
        join(
          runtime,
          "node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/history/controller.js",
        ),
      ).href
    );
    const history = new HistoryController(ctx);
    return {
      ctx,
      p: (ctx.agentgamer ?? ctx.rushagent).platform,
      service: ctx.agentgamer ?? ctx.rushagent,
      close: () => ctx.fiber.dispose(),
      history: async (id) =>
        history.events(
          { address: { kind: "session", sessionId: id }, maxMessages: 100 },
          new AbortController().signal,
        ),
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
