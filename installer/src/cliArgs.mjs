// Pure argv parser — no process.exit, no I/O — so it's directly unit-testable.

const FLAG_WITH_VALUE = new Set(["--ref", "--dir", "--from", "--name", "--worker-name"]);

export function parseArgs(argv) {
	const options = {
		yes: false,
		dryRun: false,
		help: false,
		ref: "main",
		dir: undefined,
		from: undefined,
		assistantName: undefined,
		workerName: undefined,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--yes":
			case "-y":
				options.yes = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--ref":
				options.ref = requireValue(argv, ++i, arg);
				break;
			case "--dir":
				options.dir = requireValue(argv, ++i, arg);
				break;
			case "--from":
				options.from = requireValue(argv, ++i, arg);
				break;
			case "--name":
				options.assistantName = requireValue(argv, ++i, arg);
				break;
			case "--worker-name":
				options.workerName = requireValue(argv, ++i, arg);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}

	if (options.dryRun) {
		// A --dry-run transcript must be reproducible without a terminal attached (CI, this repo's
		// own verification runs, etc.) — it never prompts, regardless of --yes.
		options.yes = true;
	}

	return options;
}

function requireValue(argv, index, flagName) {
	const value = argv[index];
	if (value === undefined || FLAG_WITH_VALUE.has(value)) {
		throw new Error(`${flagName} requires a value`);
	}
	return value;
}

export const HELP_TEXT = `create-orla — one-line install of Orla into your own Cloudflare account

Usage:
  npm create orla [-- options]

Options:
  --yes            Skip prompts, using defaults / environment variables where possible
  --dry-run        Print the commands this would run, without executing anything
  --ref <ref>      Git ref to clone (default: main)
  --dir <path>     Directory to clone into (default: ./orla)
  --name <name>    Assistant name (default: Orla)
  --worker-name <name>  Cloudflare Worker name (default: orla)
  --from <step>    Resume from a specific step after a failure
  -h, --help       Show this help
`;
