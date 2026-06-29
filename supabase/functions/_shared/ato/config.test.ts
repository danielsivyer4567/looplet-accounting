import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ATO_REQUIRED_CONFIG,
  atoConfigHealth,
  type EnvReader,
  readAtoEvteConfig,
} from "./config.ts";

function env(values: Record<string, string | undefined>): EnvReader {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}

Deno.test("readAtoEvteConfig reports every missing EVTE/DSP setting", () => {
  const result = readAtoEvteConfig(env({}));

  assertEquals(result.configured, false);
  assertEquals(result.config, null);
  assertEquals(result.missing, [...ATO_REQUIRED_CONFIG]);
});

Deno.test("readAtoEvteConfig trims blanks and returns config only when complete", () => {
  const result = readAtoEvteConfig(env({
    ATO_EVTE_ENDPOINT: " https://evte.example.test ",
    ATO_DSP_ABN: " 12000000000 ",
    ATO_SOFTWARE_ID: " SW123 ",
    ATO_STIN: " STIN123 ",
    ATO_M2M_KEYSTORE_REF: " vault://ato/m2m-test ",
  }));

  assertEquals(result.configured, true);
  assertEquals(result.missing, []);
  assertEquals(result.config?.evteEndpoint, "https://evte.example.test");
  assertEquals(result.config?.dspAbn, "12000000000");
  assertEquals(result.config?.softwareId, "SW123");
  assertEquals(result.config?.stin, "STIN123");
  assertEquals(result.config?.m2mKeystoreRef, "vault://ato/m2m-test");
});

Deno.test("atoConfigHealth redacts configured values", () => {
  const health = atoConfigHealth(env({
    ATO_EVTE_ENDPOINT: "https://evte.example.test",
    ATO_DSP_ABN: "12000000000",
    ATO_SOFTWARE_ID: "SW123",
    ATO_STIN: "STIN123",
    ATO_M2M_KEYSTORE_REF: "vault://ato/m2m-test",
  }));
  const serialized = JSON.stringify(health);

  assertEquals(health.configured, true);
  assertEquals(health.missing, []);
  assertEquals(health.required, ATO_REQUIRED_CONFIG);
  assert(!serialized.includes("https://evte.example.test"));
  assert(!serialized.includes("12000000000"));
  assert(!serialized.includes("vault://ato/m2m-test"));
});
