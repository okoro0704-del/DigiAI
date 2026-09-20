export class ResolvedCredentialSecret {
  readonly #value: string;
  readonly credentialRef: string;
  readonly generation: number;

  constructor(value: string, credentialRef: string, generation: number) {
    this.#value = value;
    this.credentialRef = credentialRef;
    this.generation = generation;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): { credentialRef: string; redacted: true } {
    return { credentialRef: this.credentialRef, redacted: true };
  }

  toString(): string {
    return "[ResolvedCredentialSecret]";
  }

  valueOf(): string {
    return "[ResolvedCredentialSecret]";
  }
}

export const FIXTURE_SENTINEL_SECRET = "TEST_SECRET_DO_NOT_LEAK_3F";
