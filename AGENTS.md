# herdr-usage-status

Fonte da verdade do mod `usage-status`: um único ícone de medidor na status bar do Herdr. Clicando nele abre o painel compacto com os limites de cada assinatura.

## Regra: sempre atualizar a pasta live do Herdr

O Herdr lê os mods de `~/.config/herdr-app/mods/<nome>`. Depois de **qualquer** mudança aqui:

```sh
./sync.sh
```

O script copia `mods/usage-status` para a pasta live e roda `herdr-app check`. Não edite a pasta live diretamente.

## Ligação no layout

O layout pessoal `~/.config/herdr-app/layouts/main-ref.json` usa:

```json
{
  "id": "status",
  "type": "block",
  "content": { "mod": "usage-status" },
  "size": { "px": 28 }
}
```

Mantenha o nome da pasta `usage-status`: o `main.js` referencia `mods/usage-status/...` (helpers e SVGs) por caminho absoluto a partir de `~/.config/herdr-app`.

## Dados e credenciais

Os helpers leem credenciais locais (Keychain do Claude, `~/.codex/auth.json`) e chamam endpoints/CLIs locais. Nenhuma credencial é gravada no repositório. Os caches `.cache-*.json` são locais e ficam no `.gitignore`.

Provedores sem dados ficam ocultos no painel (Codex, por exemplo, só aparece quando houver sessão válida).

## Skill

A skill `herdr-publish` está em `.agents/skills/herdr-publish/SKILL.md`. Ela cobre validação, sync, `RECIPE.md`/`preview.png` e publicação em `herdr.dev/mods` com o tópico `herdr-mod`.
