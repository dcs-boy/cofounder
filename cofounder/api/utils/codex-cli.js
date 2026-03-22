import { spawn } from "child_process";
import dotenv from "dotenv";
dotenv.config();

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 60000;

function isRateLimitError(text) {
	const lower = text.toLowerCase();
	return (
		lower.includes("rate limit") ||
		lower.includes("rate_limit") ||
		lower.includes("overloaded") ||
		lower.includes("try again") ||
		lower.includes("too many requests") ||
		lower.includes("529") ||
		lower.includes("429")
	);
}

function buildPrompt(messages) {
	// Combine system + user messages into a single prompt for codex
	return messages
		.map((m) => {
			const role = m.role || "user";
			const content =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? m.content
								.filter((item) => item.type === "text")
								.map((item) => item.text)
								.join("\n")
						: String(m.content);
			return `[${role}]\n${content}`;
		})
		.join("\n\n");
}

async function runCodex({ prompt, model, stream }) {
	return new Promise((resolve, reject) => {
		// codex exec reads prompt from stdin when "-" is passed or no prompt arg given
		const args = ["exec", "--skip-git-repo-check"];
		if (model) {
			args.push("--model", model);
		}

		const proc = spawn("codex", args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		let cutoff_reached = false;
		let chunks_buffer = "";
		let chunks_iterator = 0;
		const chunks_every = 5;

		proc.stdout.on("data", (chunk) => {
			const content = chunk.toString();
			stdout += content;

			if (stream === process.stdout) {
				stream.write(content);
			} else if (stream?.write) {
				chunks_buffer += content;
				chunks_iterator++;

				if (stream?.cutoff) {
					if (!cutoff_reached && stdout.includes(stream.cutoff)) {
						cutoff_reached = true;
					}
				}

				if (!(chunks_iterator % chunks_every)) {
					stream.write(!cutoff_reached ? chunks_buffer : " ...");
					chunks_buffer = "";
				}
			}
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		// Write prompt via stdin
		proc.stdin.write(prompt);
		proc.stdin.end();

		proc.on("close", (code) => {
			// Flush remaining buffer
			if (stream?.write && stream !== process.stdout && chunks_buffer.length > 0) {
				stream.write(!cutoff_reached ? chunks_buffer : " ...");
			}
			if (stream?.write) {
				stream.write("\n");
			}

			if (code !== 0 && isRateLimitError(stderr)) {
				resolve({ rateLimited: true, text: "", stderr });
			} else if (code !== 0) {
				if (stdout.length > 0) {
					resolve({ rateLimited: false, text: stdout, stderr });
				} else {
					reject(new Error(`codex CLI exited with code ${code}: ${stderr}`));
				}
			} else {
				resolve({ rateLimited: false, text: stdout, stderr });
			}
		});

		proc.on("error", (err) => {
			reject(new Error(`Failed to spawn codex CLI: ${err.message}`));
		});
	});
}

async function inference({
	model = "o3",
	messages,
	stream = process.stdout,
}) {
	const prompt = buildPrompt(messages);

	let lastError = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			console.log(
				`[codex-cli] Rate limited, waiting 60s before retry ${attempt}/${MAX_RETRIES}...`,
			);
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
		}

		try {
			const result = await runCodex({ prompt, model, stream });

			if (result.rateLimited) {
				lastError = new Error(`Rate limited: ${result.stderr}`);
				continue;
			}

			if (!result.text.trim() && isRateLimitError(result.stderr)) {
				lastError = new Error(`Rate limited (empty response): ${result.stderr}`);
				continue;
			}

			return {
				text: result.text,
				usage: {
					model,
					prompt_tokens: 0,
					completion_tokens: 0,
					total_tokens: 0,
				},
			};
		} catch (err) {
			if (isRateLimitError(err.message)) {
				lastError = err;
				continue;
			}
			throw err;
		}
	}

	throw new Error(
		`[codex-cli] Max retries (${MAX_RETRIES}) exceeded. Last error: ${lastError?.message}`,
	);
}

export default {
	inference,
};
