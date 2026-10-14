import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../src/contracts/reverseEngineeringToolContracts.js";
import { TOOL_EFFECTS } from "../../src/contracts/toolEffects.js";
import { execFileOutput } from "../../src/process/ExecFileOutput.js";

type ExecFileOutputOptions = NonNullable<Parameters<typeof execFileOutput>[2]>;

it("documents the shared combined capture limit for both command tools", () => {
  for (const contract of REVERSE_ENGINEERING_TOOL_CONTRACTS)
    expect(contract.description).toContain("shared 16 MiB combined limit");
});

it("uses provider profiles supplied through the application port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-port-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const run = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options?: ExecFileOutputOptions,
    ) => ({ stdout: "injected", stderr: "" }),
  );
  const service = new ReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: "ambient-objdump" },
    commands: {
      objdump: () => ({
        executable: "injected-objdump",
        arguments: ["--injected", path],
        identity: {
          id: "test.objdump",
          name: "Injected objdump",
          version: null,
        },
        environmentOverrides: { INJECTED_PROFILE: "yes" },
      }),
      rizin: () => ({
        executable: "injected-rizin",
        arguments: ["--injected", path],
        identity: { id: "test.rizin", name: "Injected Rizin", version: null },
      }),
      radare2: () => ({
        executable: "injected-radare2",
        arguments: ["--injected", path],
        identity: {
          id: "test.radare2",
          name: "Injected Radare2",
          version: null,
        },
      }),
      radiff2: () => ({
        executable: "injected-radiff2",
        arguments: ["--injected", path],
        identity: {
          id: "test.radiff2",
          name: "Injected radiff2",
          version: null,
        },
      }),
    },
    run,
  });

  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(result.ok).toBe(true);
    const call = run.mock.calls[0];
    expect(call?.[0]).toBe("injected-objdump");
    expect(call?.[1]).toEqual(["--injected", path]);
    expect(call?.[2]?.env?.INJECTED_PROFILE).toBe("yes");
    if (result.ok) expect(result.value.provider.id).toBe("test.objdump");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not reintroduce ambient variables absent from the captured provider environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-env-"));
  const path = join(directory, "fixture.bin");
  const variable = "REA_TEST_LATE_PROVIDER_ENV";
  const previous = process.env[variable];
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  process.env[variable] = "late-ambient-value";
  const run = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options?: ExecFileOutputOptions,
    ) => ({ stdout: "captured", stderr: "" }),
  );
  const service = new ReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: "captured-objdump" },
    commands: {
      objdump: () => ({
        executable: "captured-objdump",
        arguments: [path],
        identity: {
          id: "test.objdump",
          name: "Captured objdump",
          version: null,
        },
        environmentOverrides: { PROFILE_VALUE: "explicit" },
      }),
      rizin: () => ({
        executable: "captured-rizin",
        arguments: [path],
        identity: { id: "test.rizin", name: "Captured Rizin", version: null },
      }),
      radare2: () => ({
        executable: "captured-radare2",
        arguments: [path],
        identity: {
          id: "test.radare2",
          name: "Captured Radare2",
          version: null,
        },
      }),
      radiff2: () => ({
        executable: "captured-radiff2",
        arguments: [path],
        identity: {
          id: "test.radiff2",
          name: "Captured radiff2",
          version: null,
        },
      }),
    },
    run,
  });

  try {
    await service.inspectWithObjdump({ path, operation: "file_headers" });
    expect(run.mock.calls[0]?.[2]?.env).toEqual({
      REA_OBJDUMP_COMMAND: "captured-objdump",
      PROFILE_VALUE: "explicit",
    });
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it("builds the default radare2 provider profile", () => {
  const port = createReverseEngineeringCommandPort({});
  const profile = port.radare2({ path: "a", command: "iI" });
  expect(profile.executable).toBe("radare2");
  expect(profile.arguments).toEqual([
    "-N",
    "-q",
    "-e",
    "scr.color=0",
    "-c",
    "iI",
    resolve("a"),
  ]);
  expect(profile.identity).toEqual({
    id: "radare2",
    name: "Radare2",
    version: null,
  });
  expect(profile.environmentOverrides).toBeUndefined();
});

it("resolves the radare2 executable from REA_R2_COMMAND", () => {
  const port = createReverseEngineeringCommandPort({
    REA_R2_COMMAND: "/selected/r2",
  });
  expect(port.radare2({ path: "a", command: "ij" }).executable).toBe(
    "/selected/r2",
  );
});

it("keeps the radare2 profile free of environment overrides", () => {
  const port = createReverseEngineeringCommandPort({
    PATH: "/selected/bin",
  });
  expect(
    port.radare2({ path: "a", command: "ij" }).environmentOverrides,
  ).toBeUndefined();
});

it("exposes execute_radare2_command with the same authority as the rizin tool", () => {
  const contract = REVERSE_ENGINEERING_TOOL_CONTRACTS.find(
    ({ name }) => name === "execute_radare2_command",
  );
  expect(contract).toBeDefined();
  expect(contract?.effects).toEqual(
    TOOL_EFFECTS.execute_rizin_command ?? undefined,
  );
});

it("builds the radiff2 provider profile for function and byte diffs", () => {
  const port = createReverseEngineeringCommandPort({});
  const functions = port.radiff2({
    path_a: "a",
    path_b: "b",
    operation: "functions",
  });
  expect(functions.executable).toBe("radiff2");
  expect(functions.arguments).toEqual([
    "-Cj",
    "-A",
    resolve("a"),
    resolve("b"),
  ]);
  expect(functions.identity).toEqual({
    id: "radiff2",
    name: "radiff2",
    version: null,
  });
  expect(
    port.radiff2({ path_a: "a", path_b: "b", operation: "bytes" }).arguments,
  ).toEqual(["-A", resolve("a"), resolve("b")]);
});

it("resolves the radiff2 executable from REA_RADIFF2_COMMAND", () => {
  const port = createReverseEngineeringCommandPort({
    REA_RADIFF2_COMMAND: "/selected/radiff2",
  });
  expect(
    port.radiff2({ path_a: "a", path_b: "b", operation: "bytes" }).executable,
  ).toBe("/selected/radiff2");
});
