// R14 negative fixture: String()/Number() as fake response validation must fail.
export function fakeValidate(response: unknown): string {
  return String(response) + Number(response);
}
