/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { assertAllowedImage, parseImageRef } from "./sandbox";

describe("parseImageRef", () => {
  test("defaults single-name references to docker.io/library", () => {
    expect(parseImageRef("node:22-slim")).toEqual({
      registry: "docker.io",
      repository: "library/node:22-slim",
    });
  });

  test("keeps an explicit library/ namespace", () => {
    expect(parseImageRef("library/node:22-slim")).toEqual({
      registry: "docker.io",
      repository: "library/node:22-slim",
    });
  });

  test("accepts a fully-qualified docker.io reference", () => {
    expect(parseImageRef("docker.io/library/node:22-slim")).toEqual({
      registry: "docker.io",
      repository: "library/node:22-slim",
    });
  });

  test("detects custom registries by host", () => {
    expect(parseImageRef("ghcr.io/org/img:tag")).toEqual({
      registry: "ghcr.io",
      repository: "org/img:tag",
    });
    expect(parseImageRef("localhost:5000/img:1")).toEqual({
      registry: "localhost:5000",
      repository: "img:1",
    });
  });

  test("extracts an explicit digest", () => {
    expect(parseImageRef("node@sha256:abc123")).toEqual({
      registry: "docker.io",
      repository: "library/node",
      digest: "sha256:abc123",
    });
    expect(parseImageRef("node:22-slim@sha256:abc123")).toEqual({
      registry: "docker.io",
      repository: "library/node:22-slim",
      digest: "sha256:abc123",
    });
  });
});

describe("assertAllowedImage", () => {
  test("allows the default docker.io registry", () => {
    expect(assertAllowedImage("node:22-slim").registry).toBe("docker.io");
  });

  test("refuses images from unlisted registries", () => {
    expect(() => assertAllowedImage("ghcr.io/org/img")).toThrow(/not in the allowlist/);
    expect(() => assertAllowedImage("registry.example.com/img:1")).toThrow(/not in the allowlist/);
    expect(() => assertAllowedImage("localhost:5000/img")).toThrow(/not in the allowlist/);
  });
});
