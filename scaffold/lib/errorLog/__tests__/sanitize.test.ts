import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homePattern, sanitize, sanitizeDeep, SANITIZE_RULES, usableSecrets, userPattern } from "../sanitize";

const s = (text: string, ctx = {}) => sanitize(text, ctx);

describe("sanitize: API keys and tokens", () => {
  const cases: Array<[string, string, string]> = [
    ["Anthropic key", "key sk-ant-api03-AbC_dEf-123456789xyz rejected", "key [redacted-key] rejected"],
    ["OpenAI project key", "Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrSt1234.", "Incorrect API key provided: [redacted-key]."],
    ["OpenAI legacy key", "sk-AbCdEfGhIjKlMnOpQrSt1234", "[redacted-key]"],
    ["OpenRouter key", "sk-or-v1-0123456789abcdef0123456789abcdef", "[redacted-key]"],
    ["Google key", "x-goog: AIzaSyA1234567890abcdefghijklmnopq end", "x-goog: [redacted-key] end"],
    ["Groq key", "gsk_abcdefghijklmnopqrstuvwxyz123456", "[redacted-key]"],
    ["xAI key", "xai-abcdefghijklmnopqrstuvwxyz0123", "[redacted-key]"],
    ["Hugging Face token", "hf_abcdefghijklmnopqrstuvwxyz0123", "[redacted-key]"],
    ["GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "token [redacted-key]"],
    ["GitHub fine-grained token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "[redacted-key]"],
    ["Bearer token", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc-def_ghi", "Authorization: Bearer [redacted]"],
    ["bearer, lower case", "bearer abcdef123456", "bearer [redacted]"],
    ["Basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: Basic [redacted]"],
    ["key= query param", "GET https://generativelanguage.googleapis.com/v1/models?key=abc123secret&alt=json", "GET https://generativelanguage.googleapis.com/v1/models?key=[redacted]&alt=json"],
    ["api_key= query param", "https://x.example/a?foo=1&api_key=SECRETVALUE", "https://x.example/a?foo=1&api_key=[redacted]"],
    ["token= query param, any case", "https://x.example/a?Token=SECRETVALUE#frag", "https://x.example/a?Token=[redacted]#frag"],
    ["x-api-key header", "x-api-key: plainsecretvalue", "x-api-key: [redacted]"],
    ["JSON apiKey field", '{"apiKey":"plainsecretvalue","model":"gpt"}', '{"apiKey":"[redacted]","model":"gpt"}'],
    ["password field", "password=hunter22", "password=[redacted]"],
    ["env assignment", "OPENAI_API_KEY=whatever-it-is EXA_API_KEY=abc123", "OPENAI_API_KEY=[redacted] EXA_API_KEY=[redacted]"],
    ["env token assignment", "GITHUB_TOKEN = abcdef", "GITHUB_TOKEN = [redacted]"],
    ["credentials in a URL", "fetch https://bob:s3cr3t@proxy.example:8080/x failed", "fetch https://[redacted]@proxy.example:8080/x failed"],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => assert.equal(s(input), expected));
  }

  test("the .env.example placeholders are not mistaken for keys", () => {
    assert.equal(s("sk-ant-..."), "sk-ant-...");
    assert.equal(s("sk-..."), "sk-...");
  });

  test("ordinary words are left alone", () => {
    const text = "The search didn't complete. Please try again. task-runner sk8 skeleton keyboard monkey=1";
    assert.equal(s(text), text);
  });

  test("several secrets on one line all go", () => {
    const out = s("a sk-ant-AAAAAAAAAAAAAAAA b AIzaSyA1234567890abcdefghijk c gsk_abcdefghijklmnop12");
    assert.equal(out, "a [redacted-key] b [redacted-key] c [redacted-key]");
  });
});

describe("sanitize: token and secret fields, Authorization schemes (review of #286)", () => {
  const cases: Array<[string, string, string]> = [
    ["JSON token field", '{"token":"abc123def456","user":"x"}', '{"token":"[redacted]","user":"x"}'],
    ["JSON secret field", '{"secret": "s3cr3t-value"}', '{"secret": "[redacted]"}'],
    ["auth_token / id_token / api_secret fields", "auth_token=zzzz1111 id_token: yyyy2222 api_secret=xxxx3333", "auth_token=[redacted] id_token: [redacted] api_secret=[redacted]"],
    ["token: in YAML-ish text", "token: opaque-proxy-token-99", "token: [redacted]"],
    ["Authorization: Token …", "Authorization: Token abcdef0123456789", "Authorization: Token [redacted]"],
    ["Authorization with a raw key", "authorization: plainkeyvalue123", "authorization: [redacted]"],
    ["Proxy-Authorization", "Proxy-Authorization: Digest username=x", "Proxy-Authorization: Digest [redacted]"],
    ["Authorization in a JSON header map", '{"Authorization":"ApiKey zzzzzz"}', '{"Authorization":"ApiKey [redacted]"}'],
    ["secret= query param", "https://x.example/cb?secret=abcd&x=1", "https://x.example/cb?secret=[redacted]&x=1"],
  ];
  for (const [name, input, expected] of cases) test(name, () => assert.equal(s(input), expected));

  test("token counts and similar words are not secrets", () => {
    const text = "max_tokens: 4096; tokens: 500; tokenizer=fast; secrets are kept; the token expired";
    assert.equal(s(text), text);
  });
});

describe("sanitize: private hosts and folder names (review of #286)", () => {
  test("configured private hosts (a self-hosted provider's base URL) are redacted, whole names only", () => {
    const ctx = { hosts: ["llm.acme-corp.example", "gpu-box"] };
    assert.equal(s("connect ECONNREFUSED https://llm.acme-corp.example:8443/v1/chat", ctx), "connect ECONNREFUSED https://[private-host]:8443/v1/chat");
    assert.equal(s("fetch http://GPU-BOX:11434/api failed", ctx), "fetch http://[private-host]:11434/api failed");
    assert.equal(s("gpu-boxes and my.gpu-box.example stay", ctx), "gpu-boxes and my.gpu-box.example stay");
  });
  test("private network addresses and .local/.internal hosts in URLs", () => {
    assert.equal(s("http://192.168.1.20:11434 and 10.0.0.5 and 172.20.3.4"), "http://[private-host]:11434 and [private-host] and [private-host]");
    assert.equal(s("https://ollama.lan/api and http://box.local:8080/x"), "https://[private-host]/api and http://[private-host]:8080/x");
    assert.equal(s("https://models.corp/v1"), "https://[private-host]/v1");
  });
  test("loopback, public hosts and version numbers stay", () => {
    const text = "http://127.0.0.1:11434 http://localhost:3000 https://api.openai.com/v1 172.15.0.1 win32 10.0.26200 x64 v10.1.2";
    assert.equal(s(text), text);
  });
  test("a OneDrive folder named after an employer becomes just OneDrive", () => {
    assert.equal(s("C:\\Users\\jane\\OneDrive - Contoso Ltd\\Documents\\granted"), "~\\OneDrive\\Documents\\granted");
    assert.equal(s("~/OneDrive - Fabrikam, Inc./x"), "~/OneDrive/x");
    assert.equal(s("saved to OneDrive - Contoso"), "saved to OneDrive");
  });
  test("privateHosts(): which configured hosts count as private", async () => {
    const { privateHosts } = await import("../sanitize");
    assert.deepEqual(
      privateHosts([
        "http://127.0.0.1:11434",
        "http://localhost:8082",
        "https://api.openai.com/v1",
        "https://eu.api.openai.com/v1",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "https://llm.acme-corp.example/v1",
        "gpu-box:11434",
        "http://[::1]:1234",
        "not a url at all %%",
        "",
        42,
      ]),
      ["llm.acme-corp.example", "gpu-box"],
    );
  });
});

describe("sanitize: email addresses", () => {
  test("plain, dotted, plus-addressed and subdomain addresses", () => {
    assert.equal(s("from jane.doe+granted@mail.example.co.uk to ops@example.com"), "from [email] to [email]");
  });
  test("an address inside a message", () => {
    assert.equal(s("User <kurt@example.org> not found"), "User <[email]> not found");
  });
  test("not an email: a decorator or a version", () => {
    assert.equal(s("@huggingface/transformers@4.3.0"), "@huggingface/transformers@4.3.0");
  });
});

describe("sanitize: home folder and user name", () => {
  test("any Windows profile path, with either slash or doubled backslashes (JSON)", () => {
    assert.equal(s("at C:\\Users\\Jane Doe\\granted\\scaffold\\x.ts:1"), "at ~\\granted\\scaffold\\x.ts:1");
    assert.equal(s("file:///C:/Users/jane/granted/x.ts"), "file:///~/granted/x.ts");
    assert.equal(s('{"path":"C:\\\\Users\\\\jane\\\\granted"}'), '{"path":"~\\\\granted"}');
    assert.equal(s("c:\\users\\jane\\x"), "~\\x");
  });
  test("macOS and Linux homes", () => {
    assert.equal(s("open /Users/jane/granted/data failed"), "open ~/granted/data failed");
    assert.equal(s("ENOENT: /home/jane/.granted/settings.json"), "ENOENT: ~/.granted/settings.json");
  });
  test("a home folder somewhere unusual, from the context", () => {
    const ctx = { home: "D:\\Profiles\\jane" };
    assert.equal(s("at D:\\Profiles\\jane\\granted\\x.ts", ctx), "at ~\\granted\\x.ts");
    assert.equal(s("at d:/profiles/JANE/granted/x.ts", ctx), "at ~/granted/x.ts");
    // A longer name that only starts with it is someone else's folder.
    assert.equal(s("D:\\Profiles\\janet\\x", ctx), "D:\\Profiles\\janet\\x");
  });
  test("the user name on its own, as a whole word, any case", () => {
    const ctx = { user: "jdoe" };
    assert.equal(s("owner jdoe, group JDOE", ctx), "owner [user], group [user]");
    assert.equal(s("jdoe2 and xjdoe stay", ctx), "jdoe2 and xjdoe stay");
    assert.equal(s("jdoe", ctx), "[user]");
  });
  test("too-short user names and too-broad homes are ignored", () => {
    assert.equal(s("an ox at C:\\x", { user: "ox", home: "C:\\" }), "an ox at C:\\x");
    assert.equal(homePattern("/"), null);
    assert.equal(homePattern("C:\\"), null);
    assert.equal(userPattern("ab"), null);
  });
});

describe("sanitize: literal secrets (.env.local values, a saved key)", () => {
  test("every occurrence is redacted, longest first", () => {
    const ctx = { secrets: ["my-custom-provider-key-1", "my-custom-provider-key-1-extended"] };
    assert.equal(s("a my-custom-provider-key-1-extended b my-custom-provider-key-1", ctx), "a [redacted] b [redacted]");
  });
  test("a secret that looks like nothing in particular", () => {
    assert.equal(s("auth failed for zzTopSecret", { secrets: ["zzTopSecret"] }), "auth failed for [redacted]");
  });
  test("short or empty values are not redacted on sight (too likely to be ordinary words)", () => {
    assert.deepEqual(usableSecrets(["", "  ", "abc", "true", "longenough"]), ["longenough"]);
  });
  test("regex characters in a secret are matched literally", () => {
    assert.equal(s("x a.b*c+d?e(f) y", { secrets: ["a.b*c+d?e(f)"] }), "x [redacted] y");
    assert.equal(s("x aXbbc y", { secrets: ["a.b*c"] }), "x aXbbc y");
  });
});

describe("sanitize: robustness", () => {
  test("non-strings and empties", () => {
    assert.equal(sanitize(undefined), "");
    assert.equal(sanitize(null), "");
    assert.equal(sanitize(42), "42");
    assert.equal(sanitize(""), "");
  });
  test("running it twice changes nothing more (sanitized before storing AND before sending)", () => {
    const text = "C:\\Users\\jane\\x sk-ant-AAAAAAAAAAAAAAAA jane@example.com https://a.example/?key=zzz Bearer abcdefgh";
    const once = s(text, { user: "jane" });
    assert.equal(s(once, { user: "jane" }), once);
  });
  test("big input stays fast (no catastrophic backtracking)", () => {
    const big = `${"a".repeat(50_000)}@${"b-".repeat(20_000)} ${"x=".repeat(20_000)} ${"C:\\Users\\".repeat(2000)}`;
    const t0 = Date.now();
    sanitize(big, { home: "C:\\Users\\jane", user: "jane", secrets: ["zzzzzzzz"] });
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  });
  test("sanitizeDeep walks objects and arrays", () => {
    const out = sanitizeDeep({ a: "x jane@example.com", b: ["sk-ant-AAAAAAAAAAAAAAAA", 3], c: { d: true } });
    assert.deepEqual(out, { a: "x [email]", b: ["[redacted-key]", 3], c: { d: true } });
  });
  test("every rule compiles in JavaScript and has a name, a flag of '' or 'i', and a replacement", () => {
    for (const r of SANITIZE_RULES) {
      assert.ok(r.name && r.replacement !== undefined, r.name);
      assert.ok(r.flags === "" || r.flags === "i", r.name);
      assert.doesNotThrow(() => new RegExp(r.pattern, `g${r.flags}`), r.name);
      // .NET compatibility: no named groups and no lookbehind in the shared list.
      assert.doesNotMatch(r.pattern, /\(\?<[=!A-Za-z]/, r.name);
    }
  });
});
