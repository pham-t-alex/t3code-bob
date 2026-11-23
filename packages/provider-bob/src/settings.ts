import { makeBinaryPathSetting, makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const BobSettings = makeProviderSettingsSchema(
  {
    // Off by default like Kiro: users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("bob").pipe(
      Schema.annotateKey({
        title: "Binary path",
        providerSettingsForm: { placeholder: "bob", clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type BobSettings = typeof BobSettings.Type;
