import { describe, expect, test } from "vitest";
import { validateImport, MAX_IMPORT_BYTES } from "../src/lib/packageValidator";
import { digestPayload } from "../src/lib/envelope";
import type { AssembledPackage } from "../src/lib/contracts/package";
import { validPackage, validEnvelopeJson } from "./fixtures/package";

/** Wrap a (possibly honesty-violating) payload in a correctly-digested envelope JSON string. */
async function envelopeJsonFor(payload: AssembledPackage): Promise<string> {
  const digestValue = await digestPayload(payload);
  return JSON.stringify({
    format: "granted.autofill.package",
    version: 1,
    generated_at: "2026-08-16T00:00:00.000Z",
    opportunity_id: payload.opportunity_id,
    program_title: payload.program_title,
    digest: { alg: "SHA-256", value: digestValue },
    payload,
  });
}

describe("validateImport — the import pipeline (spec §6.3, INV-8)", () => {
  test("accepts a well-formed, correctly-digested, honesty-valid package", async () => {
    const json = await validEnvelopeJson();
    const result = await validateImport(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.opportunity_id).toBe("opp-123");
      expect(result.envelope.payload.forms.gaps).toContain("[you to provide: organization legal name]");
    }
  });

  test("rejects an oversized payload BEFORE parsing (size cap)", async () => {
    const huge = "x".repeat(MAX_IMPORT_BYTES + 1);
    const result = await validateImport(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  test("rejects malformed JSON", async () => {
    const result = await validateImport("{ not: valid json ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  test("rejects an unknown envelope format literal", async () => {
    const json = await validEnvelopeJson();
    const tampered = JSON.parse(json);
    tampered.format = "something.else";
    const result = await validateImport(JSON.stringify(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_envelope");
  });

  test("rejects an unknown envelope version", async () => {
    const json = await validEnvelopeJson();
    const tampered = JSON.parse(json);
    tampered.version = 2;
    const result = await validateImport(JSON.stringify(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_envelope");
  });

  test("rejects a shape mismatch (missing required envelope field)", async () => {
    const json = await validEnvelopeJson();
    const tampered = JSON.parse(json);
    delete tampered.opportunity_id;
    const result = await validateImport(JSON.stringify(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_envelope");
  });

  test("rejects a TAMPERED payload whose digest no longer matches", async () => {
    const json = await validEnvelopeJson();
    const tampered = JSON.parse(json);
    tampered.payload.program_title = "Something Else Entirely";
    const result = await validateImport(JSON.stringify(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("digest_mismatch");
  });

  test("rejects a malformed digest.value shape", async () => {
    const json = await validEnvelopeJson();
    const tampered = JSON.parse(json);
    tampered.digest.value = "not-hex!!";
    const result = await validateImport(JSON.stringify(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_envelope");
  });

  test("rejects a package whose forms fail the honesty contract (prefilled field missing source)", async () => {
    const pkg = validPackage();
    // Directly construct a payload that VIOLATES PrefilledFieldSchema's
    // superRefine (a prefilled field with no source) — bypassing the app-side
    // constructor so this test proves the IMPORT pipeline itself catches it.
    const badField = pkg.forms.forms[0]!.fields[0]! as unknown as Record<string, unknown>;
    delete badField.source;
    const result = await validateImport(await envelopeJsonFor(pkg));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_forms_contract");
  });

  test("rejects a package where a gap field carries a fabricated value", async () => {
    const pkg = validPackage();
    const gapField = pkg.forms.forms[0]!.fields[1]! as unknown as Record<string, unknown>;
    gapField.value = "Acme Corp"; // gap field now carries a value — a fabrication
    const result = await validateImport(await envelopeJsonFor(pkg));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_forms_contract");
  });

  test("rejects a package whose gaps[] list doesn't match the actual gap displays", async () => {
    const pkg = validPackage();
    pkg.forms.gaps = ["[you to provide: something completely different]"];
    const result = await validateImport(await envelopeJsonFor(pkg));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_forms_contract");
  });

  test("never throws on garbage input", async () => {
    await expect(validateImport("")).resolves.toMatchObject({ ok: false });
    await expect(validateImport("null")).resolves.toMatchObject({ ok: false });
    await expect(validateImport("42")).resolves.toMatchObject({ ok: false });
    await expect(validateImport("[]")).resolves.toMatchObject({ ok: false });
  });
});
