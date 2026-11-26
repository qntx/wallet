/**
 * The one line a device signing prompt adds to `chainPrompt` (I2): what the device will display —
 * the full request for `clear`, blind signing for `blind` — so the user knows what to check on it.
 */
import type { DeviceDisplay, HardwareDevice } from "@qntx/wallet/protocol";

import type { PromptLocale } from "../../prompts.ts";
import { HARDWARE_DEVICE_NAME } from "../../prompts.ts";

const LINES: Readonly<Record<PromptLocale, Readonly<Record<DeviceDisplay, string>>>> = {
  "zh-Hans": {
    clear: "设备将完整显示请求内容，请在设备上核对",
    blind: "设备无法显示此请求的完整内容，属于盲签",
  },
  en: {
    clear: "the device shows the full request — check it on the device",
    blind: "the device cannot show this request in full — signing is blind",
  },
};

export function devicePromptLine(
  locale: PromptLocale,
  display: DeviceDisplay,
  device: HardwareDevice,
): string {
  return `${HARDWARE_DEVICE_NAME[device]}: ${LINES[locale][display]}`;
}
