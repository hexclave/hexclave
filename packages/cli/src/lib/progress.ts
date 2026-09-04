const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type ProgressStream = {
  isTTY?: boolean,
  write: (chunk: string) => void,
};

export type Progress = {
  update: (message: string) => void,
  stop: (finalMessage?: string) => void,
};

type ProgressOptions = {
  prefix?: string,
  stream?: ProgressStream,
};

/**
 * Reports long-running CLI work without contaminating stdout. Interactive
 * terminals get a single animated line, while redirected output gets durable
 * lines that remain useful in CI logs.
 */
export function startProgress(initialMessage: string, options: ProgressOptions = {}): Progress {
  const stream = options.stream ?? process.stderr;
  const prefix = options.prefix ?? "";
  let message = initialMessage;
  let stopped = false;

  if (!stream.isTTY) {
    stream.write(`${prefix}${message}...\n`);
    return {
      update(nextMessage) {
        if (stopped || nextMessage === message) return;
        message = nextMessage;
        stream.write(`${prefix}${message}...\n`);
      },
      stop(finalMessage) {
        if (stopped) return;
        stopped = true;
        if (finalMessage != null) {
          stream.write(`${prefix}${finalMessage}\n`);
        }
      },
    };
  }

  let frameIndex = 0;
  const render = () => {
    stream.write(`\r\x1b[2K${prefix}${SPINNER_FRAMES[frameIndex]} ${message}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = setInterval(render, SPINNER_INTERVAL_MS);
  timer.unref();

  return {
    update(nextMessage) {
      if (stopped || nextMessage === message) return;
      message = nextMessage;
      render();
    },
    stop(finalMessage) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\x1b[2K");
      if (finalMessage != null) {
        stream.write(`${prefix}${finalMessage}\n`);
      }
    },
  };
}

export async function withProgress<T>(message: string, operation: () => Promise<T>, options?: ProgressOptions): Promise<T> {
  const progress = startProgress(message, options);
  try {
    return await operation();
  } finally {
    progress.stop();
  }
}
