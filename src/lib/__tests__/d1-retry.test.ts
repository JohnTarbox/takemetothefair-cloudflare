/**
 * Tests for D1 Retry Logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withD1Retry, createRetryableOperation } from "../d1-retry";

describe("withD1Retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("successful operations", () => {
    it("returns result on first successful attempt", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("passes through resolved values correctly", async () => {
      const data = { id: "123", name: "Test" };
      const operation = vi.fn().mockResolvedValue(data);

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual(data);
    });
  });

  describe("retryable errors", () => {
    it("retries on 'database is locked' error", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("database is locked"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on SQLITE_BUSY error", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("SQLITE_BUSY: database busy"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on SQLITE_LOCKED error", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("SQLITE_LOCKED"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on network error", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on connection reset", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("connection reset by peer"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on ECONNRESET", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on socket hang up", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on timeout", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("operation timeout"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("succeeds after multiple retries", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("database is locked"))
        .mockRejectedValueOnce(new Error("database is locked"))
        .mockResolvedValue("success");

      const promise = withD1Retry(operation);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(3);
    });
  });

  describe("non-retryable errors", () => {
    it("throws immediately on syntax error", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("SQLITE_ERROR: syntax error"));

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("SQLITE_ERROR: syntax error");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("throws immediately on constraint violation", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("UNIQUE constraint failed"));

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("UNIQUE constraint failed");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("throws immediately on foreign key violation", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("FOREIGN KEY constraint failed"));

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("FOREIGN KEY constraint failed");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("throws immediately on generic error", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("Something went wrong"));

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("Something went wrong");
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe("max retries exhausted", () => {
    it("throws after max retries (default 3)", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("database is locked"));

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("database is locked");
      expect(operation).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it("respects custom maxRetries option", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("database is locked"));

      const promise = withD1Retry(operation, { maxRetries: 5 });
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("database is locked");
      expect(operation).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
    });

    it("handles maxRetries of 0", async () => {
      const operation = vi.fn()
        .mockRejectedValue(new Error("database is locked"));

      const promise = withD1Retry(operation, { maxRetries: 0 });
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("database is locked");
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe("error type handling", () => {
    it("converts non-Error throws to Error", async () => {
      const operation = vi.fn()
        .mockRejectedValue("string error");

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow("string error");
    });

    it("handles undefined rejection", async () => {
      const operation = vi.fn()
        .mockRejectedValue(undefined);

      const promise = withD1Retry(operation);
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow();
    });
  });
});

describe("createRetryableOperation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a function that wraps operation with retry logic", async () => {
    const originalFn = vi.fn().mockResolvedValue("result");
    const wrappedFn = createRetryableOperation(originalFn);

    const promise = wrappedFn();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("result");
    expect(originalFn).toHaveBeenCalledTimes(1);
  });

  it("passes arguments to wrapped function", async () => {
    const originalFn = vi.fn().mockResolvedValue("result");
    const wrappedFn = createRetryableOperation(originalFn);

    const promise = wrappedFn("arg1", "arg2", { key: "value" });
    await vi.runAllTimersAsync();
    await promise;

    expect(originalFn).toHaveBeenCalledWith("arg1", "arg2", { key: "value" });
  });

  it("retries wrapped function on transient error", async () => {
    const originalFn = vi.fn()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValue("success");

    const wrappedFn = createRetryableOperation(originalFn);

    const promise = wrappedFn();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("success");
    expect(originalFn).toHaveBeenCalledTimes(2);
  });

  it("respects custom retry options", async () => {
    const originalFn = vi.fn()
      .mockRejectedValue(new Error("database is locked"));

    const wrappedFn = createRetryableOperation(originalFn, { maxRetries: 1 });

    const promise = wrappedFn();
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("database is locked");
    expect(originalFn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it("preserves function return type", async () => {
    interface User { id: string; name: string }
    const getUser = async (id: string): Promise<User> => ({ id, name: "Test" });

    const wrappedGetUser = createRetryableOperation(getUser);

    const promise = wrappedGetUser("123");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ id: "123", name: "Test" });
  });
});
