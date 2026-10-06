import { describe, expect, it, vi } from "vitest";
import * as appearance from "../src/appearance.js";

const { internals } = appearance;

function b(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

describe("TestParseOsc11", () => {
  it("test_parses_16bit_rgb", () => {
    expect(appearance.parseOsc11(b("\x1b]11;rgb:ffff/ffff/ffff\x07"))).toEqual([1.0, 1.0, 1.0]);
  });

  it("test_parses_8bit_rgb", () => {
    expect(appearance.parseOsc11(b("\x1b]11;rgb:00/00/00\x1b\\"))).toEqual([0.0, 0.0, 0.0]);
  });

  it("test_parses_hex", () => {
    const [r, , blue] = appearance.parseOsc11(b("\x1b]11;#ff8000\x07"))!;
    expect(r).toBeCloseTo(1.0);
    expect(blue).toBeCloseTo(0.0);
  });

  it("test_junk_returns_none", () => {
    expect(appearance.parseOsc11(b("garbage"))).toBeNull();
  });

  it("test_unframed_rgb_is_rejected", () => {
    expect(appearance.parseOsc11(b("rgb:ffff/ffff/ffff"))).toBeNull();
  });

  it("test_rgb_without_leading_esc_is_rejected", () => {
    expect(appearance.parseOsc11(b("]11;rgb:ffff/ffff/ffff\x07"))).toBeNull();
  });

  it("test_framed_rgb_parses", () => {
    expect(appearance.parseOsc11(b("\x1b]11;rgb:ffff/ffff/ffff\x07"))).toEqual([1.0, 1.0, 1.0]);
  });

  it("test_unterminated_rgb_is_rejected", () => {
    expect(appearance.parseOsc11(b("\x1b]11;rgb:ffff/ffff/ffff"))).toBeNull();
  });

  it("test_unframed_hex_is_rejected", () => {
    expect(appearance.parseOsc11(b("#ff8000"))).toBeNull();
  });

  it("test_framed_hex_parses", () => {
    const [r, , blue] = appearance.parseOsc11(b("\x1b]11;#ff8000\x07"))!;
    expect(r).toBeCloseTo(1.0);
    expect(blue).toBeCloseTo(0.0);
  });

  it("test_unterminated_hex_is_rejected", () => {
    expect(appearance.parseOsc11(b("\x1b]11;#ff8000"))).toBeNull();
  });
});

describe("TestClassify", () => {
  it("test_white_is_light", () => {
    expect(appearance.classify(b("\x1b]11;rgb:ffff/ffff/ffff\x07"))).toBe("light");
  });

  it("test_black_is_dark", () => {
    expect(appearance.classify(b("\x1b]11;rgb:0000/0000/0000\x07"))).toBe("dark");
  });

  it("test_near_boundary_grey_cutoff_is_pinned", () => {
    expect(appearance.classify(b("\x1b]11;rgb:8080/8080/8080\x07"))).toBe("light");
    expect(appearance.classify(b("\x1b]11;rgb:7f7f/7f7f/7f7f\x07"))).toBe("dark");
  });

  it("test_unparseable_returns_none", () => {
    expect(appearance.classify(b("nope"))).toBeNull();
  });
});

describe("TestQueryTerminalBackground", () => {
  // The Python tests skip where `termios` is missing. `queryTerminalBackground` returns null on win32.
  const itTty = it.skipIf(process.platform === "win32");

  function fakeTty(chunks: Buffer[], { clock }: { clock?: () => number } = {}) {
    const fd = 42;
    const pending = [...chunks];
    const reads: Buffer[] = [];
    const writes: string[] = [];
    const selectTimeouts: number[] = [];

    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("STY", undefined);
    vi.spyOn(internals, "stdinIsatty").mockReturnValue(true);
    vi.spyOn(internals, "stdoutIsatty").mockReturnValue(true);
    vi.spyOn(internals, "stdinFileno").mockReturnValue(fd);
    vi.spyOn(internals, "closeFileno").mockImplementation(() => {});
    vi.spyOn(internals, "tcgetattr").mockReturnValue(["old"]);
    vi.spyOn(internals, "tcsetattr").mockImplementation(() => {});
    vi.spyOn(internals, "setcbreak").mockImplementation(() => {});
    vi.spyOn(internals, "writeStdout").mockImplementation((value: string) => {
      writes.push(value);
    });
    vi.spyOn(internals, "select").mockImplementation((readFd: number, timeout: number) => {
      expect(readFd).toBe(fd);
      selectTimeouts.push(timeout);
      return pending.length > 0;
    });
    vi.spyOn(internals, "read").mockImplementation((readFd: number, size: number) => {
      expect(readFd).toBe(fd);
      expect(size).toBe(32);
      const chunk = pending.shift()!;
      reads.push(chunk);
      return chunk;
    });
    if (clock !== undefined) vi.spyOn(internals, "monotonic").mockImplementation(clock);

    return { reads, writes, selectTimeouts };
  }

  itTty("test_waits_for_da1_after_complete_osc_reply", () => {
    const osc = b("\x1b]11;rgb:1e1d/1e1d/1e1d\x07");
    const da1 = b("\x1b[?1;2c");
    const { reads, writes } = fakeTty([osc, da1]);

    expect(appearance.queryTerminalBackground()).toEqual(Buffer.concat([osc, da1]));
    expect(reads).toEqual([osc, da1]);
    expect(writes).toEqual([Buffer.concat([appearance.QUERY, appearance.DA1_QUERY]).toString("latin1")]);
  });

  itTty("test_accepts_reply_delayed_beyond_old_150ms_window", () => {
    const reply = b("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?1;2c");
    const times = [0.0, 0.2, 0.2][Symbol.iterator]();
    const { selectTimeouts } = fakeTty([reply], { clock: () => times.next().value! });

    expect(appearance.queryTerminalBackground()).toEqual(reply);
    expect(selectTimeouts).toHaveLength(1);
    expect(selectTimeouts[0]).toBeCloseTo(0.8);
  });

  itTty("test_da1_first_means_osc11_is_unsupported", () => {
    const da1 = b("\x1b[?62;1;2;6c");
    const { reads } = fakeTty([da1]);

    const reply = appearance.queryTerminalBackground();

    expect(reads).toEqual([da1]);
    expect(appearance.classify(reply!)).toBeNull();
  });

  itTty("test_accepts_da1_reply_without_parameters", () => {
    const da1 = b("\x1b[?c");
    const { reads } = fakeTty([da1]);

    expect(appearance.queryTerminalBackground()).toEqual(da1);
    expect(reads).toEqual([da1]);
  });

  itTty("test_does_not_mistake_echoed_da1_query_for_reply", () => {
    const echoedQuery = appearance.DA1_QUERY;
    const osc = b("\x1b]11;rgb:0000/0000/0000\x07");
    const da1 = b("\x1b[?1;2c");
    const { reads } = fakeTty([echoedQuery, osc, da1]);

    expect(appearance.queryTerminalBackground()).toEqual(Buffer.concat([echoedQuery, osc, da1]));
    expect(reads).toEqual([echoedQuery, osc, da1]);
  });

  itTty("test_accepts_fragmented_da1_reply", () => {
    const osc = b("\x1b]11;rgb:0000/0000/0000\x07");
    const fragments = [osc, b("\x1b[?"), b("62;1;2;6c")];
    const { reads } = fakeTty(fragments);

    expect(appearance.queryTerminalBackground()).toEqual(Buffer.concat(fragments));
    expect(reads).toEqual(fragments);
  });
});

describe("TestResolveTheme", () => {
  it("test_dark_passes_through_without_detecting", () => {
    const boom = (): never => {
      throw new Error("detect must not be called for explicit theme");
    };
    expect(appearance.resolveTheme("dark", boom)).toBe("dark");
    expect(appearance.resolveTheme("light", boom)).toBe("light");
  });

  it("test_auto_follows_detection", () => {
    expect(appearance.resolveTheme("auto", () => "light")).toBe("light");
    expect(appearance.resolveTheme("auto", () => "dark")).toBe("dark");
  });

  it("test_auto_none_falls_back_to_dark", () => {
    expect(appearance.resolveTheme("auto", () => null)).toBe("dark");
  });
});

describe("TestDetectGuards", () => {
  it("test_non_tty_returns_none", () => {
    vi.spyOn(internals, "stdinIsatty").mockReturnValue(false);
    expect(appearance.detectTerminalBackground()).toBeNull();
  });

  it("test_result_is_cached", () => {
    const fakeQuery = vi.spyOn(internals, "queryTerminalBackground").mockReturnValue(b("\x1b]11;rgb:ffff/ffff/ffff\x07"));
    expect(appearance.detectTerminalBackground()).toBe("light");
    expect(appearance.detectTerminalBackground()).toBe("light");
    expect(fakeQuery).toHaveBeenCalledTimes(1);
  });

  it("test_none_result_is_cached", () => {
    const fakeQuery = vi.spyOn(internals, "queryTerminalBackground").mockReturnValue(null);
    expect(appearance.detectTerminalBackground()).toBeNull();
    expect(appearance.detectTerminalBackground()).toBeNull();
    expect(fakeQuery).toHaveBeenCalledTimes(1);
  });

  it("test_fileno_unsupported_operation_does_not_raise", () => {
    vi.spyOn(internals, "stdinIsatty").mockReturnValue(true);
    vi.spyOn(internals, "stdoutIsatty").mockReturnValue(true);
    vi.spyOn(internals, "stdinFileno").mockImplementation(() => {
      throw new Error("fileno");
    });

    expect(appearance.detectTerminalBackground()).toBeNull();
  });

  it("test_termios_error_during_setcbreak_does_not_raise", () => {
    vi.spyOn(internals, "stdinIsatty").mockReturnValue(true);
    vi.spyOn(internals, "stdoutIsatty").mockReturnValue(true);
    vi.spyOn(internals, "stdinFileno").mockReturnValue(0);
    vi.spyOn(internals, "closeFileno").mockImplementation(() => {});
    vi.spyOn(internals, "tcgetattr").mockReturnValue([]);
    vi.spyOn(internals, "tcsetattr").mockImplementation(() => {});
    vi.spyOn(internals, "setcbreak").mockImplementation(() => {
      throw new Error("device not configured");
    });

    expect(appearance.detectTerminalBackground()).toBeNull();
  });

  it("test_isatty_raising_does_not_raise", () => {
    vi.spyOn(internals, "stdinIsatty").mockImplementation(() => {
      throw new Error("I/O operation on closed file");
    });

    expect(appearance.detectTerminalBackground()).toBeNull();
  });
});

describe("TestDrainStdin", () => {
  it("test_isatty_raising_does_not_raise", () => {
    vi.spyOn(internals, "stdinIsatty").mockImplementation(() => {
      throw new Error("I/O operation on closed file");
    });

    expect(() => appearance.drainStdin()).not.toThrow();
  });
});

describe("TestCliThemeResolution", () => {
  it("test_resolve_skips_detection_when_colors_disabled", () => {
    const boom = (): never => {
      throw new Error("must not probe when colors are off");
    };
    expect(appearance.cliTheme("auto", { detect: boom, colors: false })).toBe("dark");
  });

  it("test_resolve_probes_when_colors_enabled", () => {
    expect(appearance.cliTheme("auto", { detect: () => "light", colors: true })).toBe("light");
  });

  it("test_explicit_never_probes", () => {
    const boom = (): never => {
      throw new Error("explicit theme must not probe");
    };
    expect(appearance.cliTheme("light", { detect: boom, colors: true })).toBe("light");
  });
});

describe("TestCliShouldProbe", () => {
  it("test_run_subcommand_never_probes", () => {
    expect(appearance.cliShouldProbe(["run", "2"], { colorsEnabled: true })).toBe(false);
  });

  it("test_json_flag_never_probes", () => {
    expect(appearance.cliShouldProbe(["list", "--json"], { colorsEnabled: true })).toBe(false);
  });

  it("test_colors_disabled_never_probes", () => {
    expect(appearance.cliShouldProbe(["list"], { colorsEnabled: false })).toBe(false);
  });

  it("test_plain_command_with_colors_probes", () => {
    expect(appearance.cliShouldProbe(["list"], { colorsEnabled: true })).toBe(true);
  });
});

it("test_query_short_circuits_under_tmux", () => {
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
  vi.stubEnv("TERM", "xterm-256color");
  vi.spyOn(internals, "stdinIsatty").mockReturnValue(true);
  vi.spyOn(internals, "stdoutIsatty").mockReturnValue(true);
  vi.spyOn(internals, "stdinFileno").mockImplementation(() => {
    throw new Error("must not probe the tty under tmux");
  });
  expect(appearance.queryTerminalBackground()).toBeNull();
});

it.each(["dumb", "linux"])("test_query_short_circuits_on_known_unsupported_terminals[%s]", (term) => {
  vi.stubEnv("TERM", term);
  vi.spyOn(internals, "stdinIsatty").mockReturnValue(true);
  vi.spyOn(internals, "stdoutIsatty").mockReturnValue(true);
  vi.spyOn(internals, "stdinFileno").mockImplementation(() => {
    throw new Error("must not probe a known unsupported terminal");
  });
  expect(appearance.queryTerminalBackground()).toBeNull();
});
