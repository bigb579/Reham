# JavaScript source recovery

`recover_javascript_sources` / `recover-javascript-sources` derives readable
modules from explicitly selected UTF-8 JavaScript files or bundles. Use it on
files returned by `export_web_scripts` or other local scripts. The operation
never executes the selected or recovered application code.

## Caller-supplied engine

REA accepts Wakaru **^1.13.0** on any host that can execute the configured binary;
**Linux x64 is the only fully verified host** and other hosts are reported as
unverified. The report parser is verified with
Wakaru **1.14.0**. Another release in that range is accepted, the observed
version is reported, and a limitation records that the parser was not verified
against that release. Wakaru changes `--version`, `--json` and `provenance.json`
only by addition within a major version
([compatibility policy](https://github.com/pionxzh/wakaru/blob/v1.14.0/docs/cli.md#machine-readable-output-compatibility)),
so the parser keeps unknown report fields and reported module statuses.

Set `REA_WAKARU_COMMAND` to the absolute path of an executable supplied by the
caller. The caller takes responsibility for that binary on every host.

The binary is launched as an owned provider process, so on macOS it also needs
Apple's Swift compiler through `xcrun`: REA compiles its process-inspection
helper before starting any owned provider process.

Owned launches also gate availability on Windows. Every call is started through
`WindowsOwnedProcess`, which requires the packaged x64 native authority, so REA
does not advertise the tool on a Windows host that cannot supply it — a non-x64
Windows host, or one whose `rea-windows-x64.node` artifact is missing, stale, or
unproven — rather than offering a tool whose every call fails before Wakaru
starts. Run `rea doctor` on such a host to see the reported native failure. A missing compiler fails the
launch even when the Wakaru binary itself is correct. Install the Xcode Command
Line Tools (`xcode-select --install`) or Xcode; REA does not install them. The
same prerequisite gates process ownership inspection on macOS, so
[process capture](process-capture.md) also documents the `REA_DARWIN_SWIFTC_PATH`
and `SDKROOT` overrides for hosts without a default compiler or SDK.

Where util-linux `prlimit` is present the adapter bounds the worker with it
(default `/usr/bin/prlimit`, probed at call time; override with an absolute
`REA_JAVASCRIPT_PRLIMIT_COMMAND`). Hosts without util-linux, macOS included and
Linux images that omit it, have no such binary, so the 1 GiB address-space
ceiling is not a hard requirement: point `REA_JAVASCRIPT_PRLIMIT_COMMAND` at a
wrapper that accepts the same flags (for example
`--as= --fsize= --core= --cpu= -- command args...`) and maps them to the local
`ulimit` equivalents, and the ceiling comes back. An explicitly configured
limiter is authoritative: if it is not an executable regular file the call fails
closed instead of silently dropping the ceiling. Without any usable limiter the
operation still runs: the first call emits one warning — a `rea_warning` JSON
line on stderr for the CLI (the CLI logger is silent by default), a logger
warning for MCP — and every result lists the absent ceiling under
`limitations`. REA does not install either tool. The
120-second deadline and the input/output byte and entry ceilings are enforced
in-process on every host. Engine configuration is checked only when recovery is
requested; other REA capabilities remain available without it.

Unmodified upstream source is retained in `third_party/wakaru`, pinned to
`8219bf5016a063d7fb215101a8c45d5959ec733f` (v1.14.0, Apache-2.0).
The result reports the executed binary's exact path, SHA-256 and observed version.
The audited source revision is distinct from `executed_source_revision: null`:
a version string cannot prove which source produced a caller-supplied binary.

### Install Wakaru

Use the official release binary, the same one CI verifies:

```sh
curl -fL https://github.com/pionxzh/wakaru/releases/download/v1.14.0/wakaru-linux-x64.tar.gz | tar -xz wakaru
export REA_WAKARU_COMMAND="$PWD/wakaru"
```

Or install it from npm. Point at the platform binary, not the Node.js shim in
`node_modules/.bin`:

```sh
npm install wakaru@1.14.0
export REA_WAKARU_COMMAND="$(realpath node_modules/@wakaru/cli-linux-x64/wakaru)"
```

Both give the same binary (SHA-256
`664fa06782a61eda7ed15885134b52525fd565dd77607e642062ceb6cd927c38`).

## Recover and analyze

```sh
rea recover-javascript-sources /tmp/web-scripts/app.js /tmp/recovered-app --json
rea analyze-javascript-application /tmp/recovered-app/modules --json

# Recover related code-split chunks together; repeat --additional-path.
rea recover-javascript-sources /tmp/web-scripts/main.js /tmp/recovered-chunks \
  --additional-path /tmp/web-scripts/runtime.js \
  --additional-path /tmp/web-scripts/shared.js \
  --additional-path /tmp/web-scripts/checkout.chunk.js --json
```

MCP input:

```json
{
  "path": "/tmp/web-scripts/main.js",
  "additional_paths": [
    "/tmp/web-scripts/runtime.js",
    "/tmp/web-scripts/shared.js",
    "/tmp/web-scripts/checkout.chunk.js"
  ],
  "output_directory": "/tmp/recovered-chunks"
}
```

The output directory must be absent, absolute, and have an existing parent.
Each source is snapshotted separately in a private workspace. Multiple inputs
retain their relative directory layout and are passed together to one Wakaru
invocation, allowing cross-chunk module IDs to resolve. Inputs must be distinct;
`additional_paths` accepts up to 16 additional files. The engine writes only to
its own staging directory. Reported module paths, input identities, UTF-8 byte
ranges, regular files and emitted map representations are validated before
publication. REA writes verified bytes to an exclusively owned output tree and
rolls it back on failure. It also checks that the original source and engine
bytes remain unchanged before committing. The existing output is never overwritten.

Multi-input relative filenames must be representable unchanged as artifact paths:
NFC Unicode spelling and no literal backslashes. Unsupported layouts fail before
invoking the engine rather than silently renaming inputs referenced by source maps.

Published contents:

- `inputs/bundle.js`: exact original snapshot for a single input. Multiple inputs
  retain paths relative to their common parent under `inputs/`.
- `modules/`: derived modules and any upstream-emitted source maps.
- `reports/stdout.json` and `reports/provenance.json`: exact producer reports.
- `manifest.json`: identities, modules, transform choices, warnings and limitations.

The inline result includes complete file paths/digests/sizes, extraction ranges,
warnings and `analysis_input`, directly usable as the arguments to
`analyze_javascript_application`. `source` identifies the primary input and binds
the Evidence subject; `additional_sources` records the other snapshots and their
published copies when selected. Each module names its owning snapshot, original
path and original digest; all extraction and context ranges refer to that input.
Raw Evidence retains selected command arguments,
reported input paths, exit status, stderr and reports; temporary paths are recorded
as historical execution coordinates after their workspace is removed.

## Transform choices and interpretation

`extraction_mode` defaults to `structural` (Wakaru `--unpack=strict`). `heuristic`
uses `--unpack=auto`; `inspection` uses `--unpack=inspect` and can return finer,
non-executable regions. `rewrite_level` accepts `minimal`, `standard` (default)
and `aggressive`. Maps and provenance are requested in every operation.

Structural extraction can fall back to a single file. In the real fixtures,
webpack 5 yields two modules; the esbuild scope-hoisted fixture remains one
unknown-format script. Returned module counts and detected formats report those
actual outcomes. A valid report with failed transformations returns `partial`
with original warnings and files. An unusable report, inconsistent provenance,
escaping path, symlink or missing module is an error, with owned cleanup.

Evidence confidence is `derived`. Extraction ranges are half-open **UTF-8 byte
offsets in the original snapshot**, rather than rewritten line positions or a
coverage assertion. Source maps are preserved without claiming independently
verified mapping accuracy. Original variable names and arbitrary runtime
equivalence remain unknown. No network fetching occurs.

## Resource policy and verification

Each operation uses one worker and a 120-second deadline; it accepts up to
64 MiB of total input across all selected files and 128 MiB/10000 entries of
staged output, with 8 MiB per diagnostic/report stream. Those rails are enforced
in-process on every host. The 1 GiB address-space ceiling, and the file-size,
core-dump and cpu-time rails that come with it, exist only where a resolved
resource limiter can express util-linux `--as`: a host without a usable
`prlimit` (see setup above) runs without them, and every result states that under
`limitations`. Exceeding a limit is an explicit failure with rollback. Selected
inputs beyond the total input allowance return a non-retryable
`resource_constraint` with `resource: "file-size"` and
`reported_limits.maximum_input_bytes`/`remaining_input_bytes`; input that is not
valid UTF-8 is an `invalid_format` request issue. These limits apply per
operation and do not claim aggregate host containment across concurrent callers.

See [testing.md](testing.md#javascript-source-recovery) for the focused real
Wakaru CLI/MCP lane and its source-owned compiler fixtures. Hosts other than
linux-x64 run the same protocol against the caller-supplied binary and are
reported as unverified; Bun/Vue recovery is not claimed by this adapter.
