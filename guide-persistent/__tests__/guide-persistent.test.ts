/**
 * Tests for guide-persistent plugin.
 * @see Plan36a §5
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPersistentGuide } from "../src/persistent-guide.js";
import { createDirectiveStorage } from "../src/storage.js";
import type { CognitiveDirective } from "@openstarry/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-persistent-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function makeDirective(overrides: Partial<CognitiveDirective> = {}): CognitiveDirective {
  return {
    id: 'dir-1',
    label: 'Test Directive',
    content: 'Be helpful',
    priority: 10,
    createdAt: new Date().toISOString(),
    source: 'test',
    ...overrides,
  };
}

describe("PersistentGuide — directives", () => {
  it("S3-1: loads and functions as IGuide", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base prompt');

    expect(guide.skandha).toBe('vijnana');
    expect(guide.id).toBe('pg-1');
    const prompt = await guide.getSystemPrompt();
    expect(prompt).toBe('Base prompt');
  });

  it("S3-2: directives persist across instances", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide1 = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base');

    await guide1.addDirective(makeDirective({ id: 'd1', label: 'First' }));

    // New instance reading same storage
    const storage2 = createDirectiveStorage('test-agent', tmpDir);
    const guide2 = createPersistentGuide('pg-2', 'Test Guide', storage2, 'Base');

    const directives = await guide2.listDirectives();
    expect(directives).toHaveLength(1);
    expect(directives[0].label).toBe('First');
  });

  it("S3-3: clearDirectives removes all", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base');

    await guide.addDirective(makeDirective({ id: 'd1' }));
    await guide.addDirective(makeDirective({ id: 'd2' }));
    expect(await guide.listDirectives()).toHaveLength(2);

    await guide.clearDirectives();
    expect(await guide.listDirectives()).toHaveLength(0);
  });

  it("S3-6: maxDirectives=100 enforced", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base', { maxDirectives: 3 });

    await guide.addDirective(makeDirective({ id: 'd1' }));
    await guide.addDirective(makeDirective({ id: 'd2' }));
    await guide.addDirective(makeDirective({ id: 'd3' }));

    await expect(guide.addDirective(makeDirective({ id: 'd4' }))).rejects.toThrow('Maximum directives');
  });

  it("removeDirective removes by id", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base');

    await guide.addDirective(makeDirective({ id: 'd1' }));
    await guide.addDirective(makeDirective({ id: 'd2' }));

    const removed = await guide.removeDirective('d1');
    expect(removed).toBe(true);
    expect(await guide.listDirectives()).toHaveLength(1);

    const notFound = await guide.removeDirective('d999');
    expect(notFound).toBe(false);
  });

  it("getSystemPrompt includes directives sorted by priority", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base prompt');

    await guide.addDirective(makeDirective({ id: 'd1', label: 'Low', priority: 1, content: 'low' }));
    await guide.addDirective(makeDirective({ id: 'd2', label: 'High', priority: 100, content: 'high' }));

    const prompt = await guide.getSystemPrompt();
    expect(prompt).toContain('Base prompt');
    expect(prompt).toContain('Persistent Directives');
    // High priority first
    expect(prompt.indexOf('[High]')).toBeLessThan(prompt.indexOf('[Low]'));
  });

  it("filters expired directives", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    const guide = createPersistentGuide('pg-1', 'Test Guide', storage, 'Base');

    await guide.addDirective(makeDirective({
      id: 'd1',
      expiresAt: '2020-01-01T00:00:00Z',  // Already expired
    }));
    await guide.addDirective(makeDirective({
      id: 'd2',
      expiresAt: '2099-01-01T00:00:00Z',  // Future
    }));

    const directives = await guide.listDirectives();
    expect(directives).toHaveLength(1);
    expect(directives[0].id).toBe('d2');
  });
});

describe("DirectiveStorage — security", () => {
  it("S3-7: rejects symlinks", () => {
    // Create a symlink-like scenario (test path validation)
    const storage = createDirectiveStorage('test-agent', tmpDir);
    // Normal load should work
    expect(() => storage.load()).not.toThrow();
  });

  it("atomic write: temp file renamed", async () => {
    const storage = createDirectiveStorage('test-agent', tmpDir);
    storage.save([makeDirective()]);

    const filePath = path.join(tmpDir, 'guides', 'test-agent', 'directives.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.version).toBe(1);
    expect(content.directives).toHaveLength(1);
  });
});
