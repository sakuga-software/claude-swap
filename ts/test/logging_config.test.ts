import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEBUG, FileHandler, type Logger, StreamHandler, setupLogging } from "../src/logging_config.js";
import { testHome } from "./helpers/home.js";

function closeHandlers(logger: Logger): void {
  for (const handler of [...logger.handlers]) {
    handler.close();
    logger.removeHandler(handler);
  }
}

describe("test_logging_config", () => {
  it("test_setup_does_not_create_dir", () => {
    const logDir = path.join(testHome(), "should-not-exist");
    const logger = setupLogging(logDir);
    try {
      expect(fs.existsSync(logDir)).toBe(false);
      expect(logger.handlers.length).toBeGreaterThan(0);
    } finally {
      closeHandlers(logger);
    }
  });

  it("test_dir_is_created_on_first_log", () => {
    const logDir = path.join(testHome(), "lazy");
    const logger = setupLogging(logDir);
    try {
      expect(fs.existsSync(logDir)).toBe(false);
      logger.warning("trigger");
      for (const handler of logger.handlers) handler.flush();
      expect(fs.statSync(logDir).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(logDir, "claude-swap.log"))).toBe(true);
    } finally {
      closeHandlers(logger);
    }
  });

  it("test_debug_adds_console_handler", () => {
    const logDir = path.join(testHome(), "dbg");
    const logger = setupLogging(logDir, true);
    try {
      expect(logger.level).toBe(DEBUG);
      expect(logger.handlers.some((h) => h instanceof StreamHandler && !(h instanceof FileHandler))).toBe(true);
    } finally {
      closeHandlers(logger);
    }
  });
});

describe("logging_config format and rotation (TypeScript only)", () => {
  it("writes the Python record format with %-style arguments", () => {
    const logDir = path.join(testHome(), "fmt");
    const logger = setupLogging(logDir);
    try {
      logger.info("Rolled back %s: %s", "step", new Error("boom"));
      logger.debug("hidden at INFO");
      const text = fs.readFileSync(path.join(logDir, "claude-swap.log"), "utf8");
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - INFO - Rolled back step: boom\n$/);
    } finally {
      closeHandlers(logger);
    }
  });

  it("appends the stack of excInfo", () => {
    const logDir = path.join(testHome(), "exc");
    const logger = setupLogging(logDir);
    try {
      logger.warning("failed for %s", 3, { excInfo: new Error("inner") });
      const text = fs.readFileSync(path.join(logDir, "claude-swap.log"), "utf8");
      expect(text).toContain("WARNING - failed for 3\nError: inner\n");
    } finally {
      closeHandlers(logger);
    }
  });

  it("rotates to numbered backups at maxBytes", () => {
    const logDir = path.join(testHome(), "rot");
    const logger = setupLogging(logDir);
    try {
      const line = "x".repeat(400 * 1024);
      for (let i = 0; i < 8; i += 1) logger.info(line);
      const names = fs.readdirSync(logDir).sort();
      expect(names).toEqual(["claude-swap.log", "claude-swap.log.1", "claude-swap.log.2", "claude-swap.log.3"]);
      for (const name of names) {
        expect(fs.statSync(path.join(logDir, name)).size).toBeLessThan(1024 * 1024);
      }
    } finally {
      closeHandlers(logger);
    }
  });
});
