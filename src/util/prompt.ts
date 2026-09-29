import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function prompt(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = fallback !== undefined ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    if (!answer && fallback !== undefined) return fallback;
    return answer;
  } finally {
    rl.close();
  }
}

export async function promptRequired(question: string): Promise<string> {
  for (;;) {
    const value = await prompt(question);
    if (value) return value;
    console.log("Value required.");
  }
}
