import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CompanionFocus } from "../src/companion-focus.js";
import { CompanionEffects } from "../src/companion-effects.js";
import {
  CompanionError,
  DshPetAdapter,
  companionKey,
  type CompanionAdapter,
  type CompanionLease,
} from "../src/companion.js";
import type { CompanionDisplay } from "../src/sdk.js";
import { AgentGamerPlatform } from "../src/platform.js";
import type { GameDefinition } from "../src/sdk.js";
import type { ReportStore } from "../src/reports.js";
const ref = { entry: "main", petId: "fish" };
const display: CompanionDisplay = {
  ...ref,
  key: companionKey(ref),
  name: "伙伴",
  kind: "dsh_pet",
};
const baseAdapter: CompanionAdapter = {
  list: async () => [display],
  preview: async () => ({
    display,
    persona: "",
    turns: [],
    personaBytes: 0,
    memoryBytes: 2,
    configuredRounds: 0,
    loadedRounds: 0,
    omitted: false,
  }),
  send: async () => ({ text: "" }),
  findReceipt: async () => null,
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw Error("focus condition timed out");
};

test("native focus lease renews the same id, sets a quiet pose and borrows ownership for game speech", async () => {
  const writes: { path: string; data: any }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://test");
    if (req.method === "GET") {
      res.end(
        JSON.stringify(
          url.pathname.endsWith("config")
            ? {
                main: {
                  pets: [{ id: "fish" }],
                  animations: { idle: ["专心待机"], clicks: ["挥手"] },
                },
              }
            : { pets: {} },
        ),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    writes.push({ path: url.pathname, data });
    if (url.pathname.endsWith("/lock")) {
      assert.equal(data.ttl, 15000);
      res.end(
        JSON.stringify({
          ok: true,
          lockId: "game-lease",
          expiresAt: Date.now() + 15000,
        }),
      );
    } else {
      if (!url.pathname.endsWith("release"))
        assert.equal(url.searchParams.get("lock"), "game-lease");
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const adapter = new DshPetAdapter(
      () => `http://127.0.0.1:${(server.address() as any).port}`,
    ),
    signal = new AbortController().signal;
  try {
    const lease = await adapter.focus(ref, undefined, false, signal);
    assert.equal(writes.at(-1)!.data.name, "专心待机");
    const count = writes.length;
    await adapter.present(
      ref,
      { kind: "chat", text: "公开游戏聊天", reduceMotion: false },
      signal,
      lease,
    );
    assert.deepEqual(
      writes.slice(count).map((w) => w.path),
      ["/dsh-pet-7340/broadcast"],
    );
    await adapter.focus(ref, lease.lockId, false, signal);
    assert.deepEqual(writes.at(-1)!.data, { ttl: 15000, lockId: "game-lease" });
    await adapter.releaseFocus(ref, lease);
    assert.deepEqual(writes.at(-1)!.data, { lockId: "game-lease" });
    assert.ok(
      writes.every(
        (w) => !/chat$|whisper$|config$/.test(w.path) && !w.data.force,
      ),
    );
    const previous = writes.length;
    await adapter.focus(ref, undefined, true, signal);
    assert.equal(
      writes.length,
      previous + 1,
      "reduced motion must not request a pose animation",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("focus owns the entire game, renews without reacquiring, and restores daily behavior on finish", async () => {
  let acquires = 0,
    renews = 0,
    releases = 0;
  const adapter = {
    ...baseAdapter,
    focus: async (_ref, id) => {
      id ? renews++ : acquires++;
      return { lockId: "lease", expiresAt: Date.now() + 1000 };
    },
    releaseFocus: async () => {
      releases++;
    },
  } as CompanionAdapter;
  const focus = new CompanionFocus(adapter, () => {}, {
    renewMs: 10,
    finishMs: 10,
  });
  await focus.start(display, false);
  await until(() => renews >= 2);
  assert.equal(acquires, 1);
  assert.equal(focus.snapshot().state, "focused");
  focus.finishSoon();
  await until(() => focus.snapshot().state === "idle");
  await focus.ready();
  assert.equal(releases, 1);
  const count = renews;
  await delay(30);
  assert.equal(renews, count);
  assert.equal(focus.lease(display), undefined);
});

test("user preemption never auto-reacquires or lets a queued game bubble steal ownership", async () => {
  let acquires = 0,
    lost = false,
    presents = 0;
  const adapter = {
    ...baseAdapter,
    focus: async (_ref, id) => {
      if (id && lost) throw new CompanionError("用户接管", false, "lock-lost");
      if (!id) acquires++;
      return { lockId: "lease", expiresAt: Date.now() + 1000 };
    },
    releaseFocus: async () => {},
    present: async () => {
      presents++;
      return { animation: null };
    },
  } as CompanionAdapter;
  const focus = new CompanionFocus(adapter, () => {}, {
    renewMs: 10,
    finishMs: 10,
  });
  await focus.start(display, false);
  lost = true;
  await until(() => focus.snapshot().state === "interrupted");
  await delay(40);
  assert.equal(acquires, 1);
  assert.equal(focus.lease(display), undefined);
  lost = false;
  await focus.start(display, false);
  assert.equal(acquires, 2);
  await focus.stop();
  const effects = new CompanionEffects(adapter, () => {});
  await effects.select(display);
  await effects.focus.start(display, false);
  await effects.focus.interrupted(
    new CompanionError("用户接管", false, "lock-lost"),
  );
  effects.emit(display, {
    kind: "chat",
    text: "仍可在平台聊天",
    reduceMotion: false,
  });
  await effects.settled();
  assert.equal(presents, 0);
  assert.equal(acquires, 3);
  await effects.dispose();
});

test("late acquire and failed renewal cannot outlive cancellation or silently regain control", async () => {
  let resolve!: (lease: CompanionLease) => void,
    calls = 0,
    released = 0;
  const focus = new CompanionFocus(
    {
      ...baseAdapter,
      focus: async () => {
        calls++;
        return new Promise<CompanionLease>((r) => (resolve = r));
      },
      releaseFocus: async () => {
        released++;
      },
    } as CompanionAdapter,
    () => {},
    { renewMs: 10, finishMs: 10 },
  );
  const pending = focus.start(display, false);
  await until(() => calls === 1);
  const stopped = focus.stop();
  resolve({ lockId: "late", expiresAt: Date.now() + 1000 });
  await Promise.all([pending, stopped]);
  assert.equal(released, 1);
  assert.equal(focus.snapshot().state, "idle");
  await delay(30);
  assert.equal(calls, 1);
  let renews = 0;
  const failing = new CompanionFocus(
    {
      ...baseAdapter,
      focus: async (_ref, id) => {
        if (id) {
          renews++;
          throw Error("offline");
        }
        return { lockId: "known", expiresAt: Date.now() + 1000 };
      },
      releaseFocus: async () => {},
    } as CompanionAdapter,
    () => {},
    { renewMs: 10, finishMs: 10 },
  );
  await failing.start(display, true);
  await until(() => failing.snapshot().state === "error");
  await delay(30);
  assert.equal(renews, 1);
  await failing.stop();
});

test("platform focus covers round waits and pauses, then releases on finish, leave, unload, quit and failed start", async () => {
  let releases = 0;
  const adapter: CompanionAdapter = {
    list: async () => [display],
    preview: async () => ({
      display,
      persona: "陪玩",
      turns: [],
      personaBytes: 6,
      memoryBytes: 2,
      configuredRounds: 0,
      loadedRounds: 0,
      omitted: false,
    }),
    send: async () => ({ text: "" }),
    findReceipt: async () => null,
    present: async () => ({ animation: null }),
    focus: async () => ({
      lockId: "private-game-lease",
      expiresAt: Date.now() + 15000,
    }),
    releaseFocus: async () => {
      releases++;
    },
  };
  const p = new AgentGamerPlatform();
  p.attachCompanions(adapter, {
    ready: async () => {},
    list: () => [],
    dispose: async () => {},
    error: "",
  } as unknown as ReportStore);
  const game: GameDefinition = {
    apiVersion: 1,
    id: "focus_test",
    name: "测试",
    version: "1",
    rulesVersion: "1",
    rules: "公开",
    create: (matchId) => {
      let revision = 0;
      return {
        observe: () => ({
          matchId,
          revision,
          phase: revision ? "finished" : "round_result",
          outcome: revision ? "win" : "",
          actions: [],
        }),
        apply: () => {
          revision++;
          return "";
        },
        nextHand: () => "phase",
      };
    },
  };
  const unload = p.registerGame(game);
  p.registerGame({
    ...game,
    id: "bad_start",
    create: () => {
      throw Error("failed initialization");
    },
  });
  await p.configure(
    { provider: "mock", model: "test" },
    async () => ({
      sessionId: "game",
      selectModel: async () => {},
      cancel: async () => {},
      dispose: async () => {},
      wake: async () => {},
    }),
    { companion: ref },
  );
  await p.effectsSettled();
  assert.equal((await p.start("bad_start")).accepted, false);
  assert.equal(releases, 1);
  assert.equal(p.snapshot().companionFocus!.state, "idle");
  await p.start(game.id);
  assert.equal(p.snapshot().companionFocus!.state, "focused");
  await p.pause();
  assert.equal(
    p.snapshot().companionFocus!.state,
    "focused",
    "model pause must retain game focus",
  );
  assert.ok(!JSON.stringify(p.observeAgent()).includes("private-game-lease"));
  assert.ok(!JSON.stringify(p.snapshot()).includes("private-game-lease"));
  const o = p.snapshot().observation!;
  p.act("human", o.matchId, o.revision, "end", { kind: "end" });
  await p.effectsSettled();
  for (let i = 0; i < 200 && p.snapshot().companionFocus!.state !== "idle"; i++)
    await delay(10);
  assert.equal(p.snapshot().companionFocus!.state, "idle");
  assert.equal(releases, 2);
  await p.start(game.id, true);
  await p.leave();
  assert.equal(releases, 3);
  await p.start(game.id);
  unload();
  await until(() => releases === 4);
  assert.equal(p.snapshot().companionFocus!.state, "idle");
  p.registerGame(game);
  await p.start(game.id);
  await p.dispose();
  assert.equal(releases, 5);
});
