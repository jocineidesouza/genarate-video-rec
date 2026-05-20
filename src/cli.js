const fs = require("fs");
const path = require("path");

function usage(scriptName) {
  return [
    `Uso: node ${scriptName} <diretorio-da-gravacao>`,
    `   ou node ${scriptName} --workdir <diretorio-da-gravacao>`,
    "",
    "Exemplos PowerShell:",
    `  node ${scriptName} "C:\\Users\\me\\Downloads\\recording-123"`,
    `  node ${scriptName} --workdir "C:\\Users\\me\\Downloads\\recording-123"`,
  ].join("\n");
}

function parseWorkdirArg(argv) {
  const args = argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--workdir") {
      return args[index + 1];
    }

    if (arg.startsWith("--workdir=")) {
      return arg.slice("--workdir=".length);
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return null;
}

function getWorkdirOrExit(scriptName) {
  const workdirArg = parseWorkdirArg(process.argv);

  if (!workdirArg) {
    console.error("Diretório de trabalho não informado");
    console.error("");
    console.error(usage(scriptName));
    process.exit(1);
  }

  const workdir = path.resolve(workdirArg);

  if (!fs.existsSync(workdir)) {
    console.error(`Diretório não encontrado: ${workdir}`);
    process.exit(1);
  }

  if (!fs.statSync(workdir).isDirectory()) {
    console.error(`Diretório de trabalho inválido: ${workdir}`);
    process.exit(1);
  }

  return workdir;
}

function runCli(main, scriptName) {
  try {
    main(getWorkdirOrExit(scriptName));
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  getWorkdirOrExit,
  parseWorkdirArg,
  runCli,
  usage,
};
