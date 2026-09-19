import {
  AUTHORITY_POLICY_ID,
  AUTHORITY_POLICY_VERSION,
  AUTOMATIC_CLASSES,
  CONSEQUENTIAL_CLASSES,
  type ActionClass,
} from "../contracts/authority.js";

export type AuthorityPolicyRule = {
  actionClass: ActionClass;
  automatic: boolean;
};

export type AuthorityPolicy = {
  policyId: string;
  version: string;
  status: "active";
  effectiveFrom: string;
  effectiveTo?: string;
  rules: AuthorityPolicyRule[];
};

export const DEFAULT_AUTHORITY_POLICY: AuthorityPolicy = {
  policyId: AUTHORITY_POLICY_ID,
  version: AUTHORITY_POLICY_VERSION,
  status: "active",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  rules: [
    ...AUTOMATIC_CLASSES.map((actionClass) => ({ actionClass, automatic: true })),
    ...CONSEQUENTIAL_CLASSES.map((actionClass) => ({ actionClass, automatic: false })),
  ],
};

export function loadAuthorityPolicy(): AuthorityPolicy {
  return DEFAULT_AUTHORITY_POLICY;
}

export function classRank(actionClass: ActionClass): number {
  return {
    KNOW: 1,
    THINK: 2,
    CREATE: 3,
    CHANGE: 4,
    MESSAGE: 5,
    PUBLISH: 6,
    SPEND: 7,
    DEPLOY: 8,
    DELETE: 9,
  }[actionClass];
}

export function strongestClass(classes: ActionClass[]): ActionClass {
  return classes.reduce((strongest, current) => (classRank(current) > classRank(strongest) ? current : strongest));
}

export function isAutomaticClass(actionClass: ActionClass): boolean {
  return loadAuthorityPolicy().rules.find((rule) => rule.actionClass === actionClass)?.automatic === true;
}
