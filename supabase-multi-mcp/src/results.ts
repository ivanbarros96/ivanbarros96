export function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

export function errorResult(error: unknown) {
  let message = "Error desconocido";
  if (error instanceof Error) {
    message = error.message;
  } else if (
    typeof error === "object" && error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    message = (error as { message: string }).message;
  }
  return { ...jsonResult({ ok: false, error: message }), isError: true };
}
