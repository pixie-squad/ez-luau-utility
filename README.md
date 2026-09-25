> [!WARNING]
> Generative AI was heavily used for code-related tasks.

# ez-luau-utility

ez-luau-utility is a VS Code extension for scripting runtimes that can execute Luau but cannot access a filesystem. It uses [darklua](https://darklua.com/) to turn an entry file and its requires into one self-contained `.bundle.luau` file.
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

darklua is bundled with the extension for Windows x64, Linux x64/ARM64, and macOS x64/ARM64. `ezLuauUtility.darklua.path` remains available as an optional executable override. Open source buffers are staged before darklua runs, so unsaved edits in the entry file or an imported module are included. The generated file is marked as generated and may be safely overwritten by later compilations.

## Module behavior

- Bundling uses darklua's path require mode with `.luaurc` alias support enabled.
- Relative Lua/Luau modules, `init` modules, and darklua-supported JSON, JSON5, YAML, TOML, and text data requires can be bundled.
- Source and data files are staged inside a temporary workspace so open editor buffers remain authoritative.
- Generated `.bundle.luau` files are excluded from the staging input.
- darklua emits readable output and the extension adds a `--!nocheck` generated-file header.

The generated artifact starts with `--!nocheck`. Keep type checking enabled on the original source files; exported module type namespaces do not survive flattening as native `require` namespaces.

## Remote scripting sidebar

- Script-list loads first validate the stored session through `/api/users/me`, so expired authentication is refreshed before private scripts are requested.
- **Start Battle** uses the saved advanced battle parameters.
- **Configure Battle Settings** is available from the Script Explorer overflow menu and the Command Palette. Settings are grouped in compact quick-pick menus rather than adding another persistent sidebar panel.

## Development

```text
npm install
npm test
npm run build
npm run package:vsix
```

Open this extension folder in VS Code and run the **Run Extension** debug configuration to launch an Extension Development Host.
