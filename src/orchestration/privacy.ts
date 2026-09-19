import { privacyRank, type PrivacyClass } from "../contracts/privacy.js";

export function strictestPrivacy(values: PrivacyClass[]): PrivacyClass {
  return values.reduce((strictest, current) => (privacyRank(current) > privacyRank(strictest) ? current : strictest));
}
