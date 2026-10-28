// R9 negative fixture: a required product capability declared optional must fail the gate.
export interface SceneCommands {
  setView?(preset: string): void;
  resize(): void;
}
