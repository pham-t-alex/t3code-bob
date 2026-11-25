import {
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
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
    // The settings form edits text, so the number is stored as typed.
    monthlyBobcoinLimit: Schema.optionalKey(
      TrimmedString.check(Schema.isPattern(/^[1-9]\d{0,8}(\.\d+)?$/)),
    ).pipe(
      Schema.annotateKey({
        title: "Monthly Bobcoin limit",
        description:
          "Your monthly Bobcoin allowance. Usage limits then show how much of it Bob has used this month on this computer. Resets on the 1st, US Eastern time.",
        providerSettingsForm: { placeholder: "None", clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["binaryPath", "monthlyBobcoinLimit"],
  },
);
export type BobSettings = typeof BobSettings.Type;
