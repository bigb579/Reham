type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Exit status a signal-terminated process reports (128 + signal number). */
const SIGNAL_EXIT_STATUS: Readonly<Record<ShutdownSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

interface ShutdownSignalSource {
  on(event: ShutdownSignal, listener: () => void): unknown;
  off(event: ShutdownSignal, listener: () => void): unknown;
}

interface ShutdownInputSource {
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
}

interface ProcessShutdownEvents {
  readonly signals: ShutdownSignalSource;
  /** Absent when the transport does not own stdin, as the HTTP listener does not. */
  readonly stdin?: ShutdownInputSource;
}

const processShutdownEvents: ProcessShutdownEvents = {
  signals: process,
  stdin: process.stdin,
};

/** Receives the signal that requested shutdown; stdin end and close carry none. */
type ShutdownHandler = (signal?: ShutdownSignal) => void;

/** Register the process events that request shutdown and return their owner. */
export const registerProcessShutdown = (
  handler: ShutdownHandler,
  events: ProcessShutdownEvents = processShutdownEvents,
): (() => void) => {
  const onInterrupt = (): void => handler("SIGINT");
  const onTerminate = (): void => handler("SIGTERM");
  const onInputEnd = (): void => handler();
  events.signals.on("SIGINT", onInterrupt);
  events.signals.on("SIGTERM", onTerminate);
  events.stdin?.on("end", onInputEnd);
  events.stdin?.on("close", onInputEnd);
  return () => {
    events.signals.off("SIGINT", onInterrupt);
    events.signals.off("SIGTERM", onTerminate);
    events.stdin?.off("end", onInputEnd);
    events.stdin?.off("close", onInputEnd);
  };
};

/** Register signals only, for a transport that does not own stdin, and report the signal's exit status. */
export const registerSignalShutdown = (
  handler: (exitStatus: number) => void,
  signals: ShutdownSignalSource = process,
): (() => void) =>
  registerProcessShutdown(
    (signal) => {
      if (signal !== undefined) handler(SIGNAL_EXIT_STATUS[signal]);
    },
    { signals },
  );
