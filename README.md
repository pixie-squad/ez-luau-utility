> [!WARNING]
> Generative AI was heavily used for code-related tasks.

# ez-luau-utility

ez-luau-utility is a VS Code extension for scripting runtimes that can execute Luau but cannot access a filesystem. It turns static relative `require` calls into one self-contained `.bundle.luau` file.
It also features remote development features for NT Scripting.

## Installation

In VS Code, run **Extensions: Install from VSIX...** and select `ez-luau-utility-0.3.1.vsix`. You can also install it from a terminal:

```text
code --install-extension ez-luau-utility-0.3.1.vsix
```

## Usage

Write ordinary Luau modules that return a value:

```luau
-- utils/collision.luau
local Collision = {}

function Collision.isInside(value: number): boolean
	return value >= 0
end

return Collision
```

Require them from an entry script:

```luau
-- main.luau
local Collision = require("./utils/collision")

function tick()
	log(tostring(Collision.isInside(server.tick)))
end
```

Open `main.luau`, then run **ez-luau-utility: Compile Active File** from the Command Palette. The extension writes `main.bundle.luau` beside the entry file.

Open source buffers are authoritative, so unsaved edits in the entry file or an imported module are included. The generated file is marked as generated and may be safely overwritten by later compilations.

## Module behavior

- Static `require("./path")` and `require("../path")` calls are supported.
- Single and double quotes are accepted. Escapes and dynamic expressions are rejected.
- An explicit `.lua` or `.luau` extension is resolved exactly.
- An extensionless path checks `<path>.luau` and `<path>.lua`; compilation fails if neither or both exist.
- Imports are restricted to the workspace folder. Absolute paths, `.luaurc` aliases, directory `init` modules, generated bundles, and circular dependencies are rejected.
- Every module is isolated in a loader function, runs at its first require call, is cached after a successful load, and contributes its first return value.
- Imported source is emitted above the entry source. Internal names are selected to avoid collisions with source text.

The generated artifact starts with `--!nocheck`. Keep type checking enabled on the original source files; exported module type namespaces do not survive flattening as native `require` namespaces.

## Remote scripting sidebar
self-explanatory

## Development

```text
npm install
npm test
npm run build
npm run package:vsix
```

Open this extension folder in VS Code and run the **Run Extension** debug configuration to launch an Extension Development Host.
