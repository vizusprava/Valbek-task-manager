# 3D Lab

Testovací prostředí pro 3D viewer — běží úplně samostatně, bez Supabase, bez loginu, bez zbytku task manageru.

## Spuštění

```bash
cd 3d-lab
npm install   # jen poprvé
npm run dev   # http://localhost:5173
```

Přetáhni do okna libovolný `.glb` / `.gltf` soubor. Vegetace, anotace, barvy objektů i pozice kamery se ukládají do localStorage (klíčem je název + velikost souboru), takže při dalším otevření stejného modelu se obnoví.

## Jak to souvisí s hlavní aplikací

Lab **neobsahuje kopii** 3D kódu. Přes Vite alias `@core` importuje přímo sdílené jádro z `../react-app/src/viewer-core/` — stejné soubory, které používá hlavní appka na stránce 3D Modely. Cokoliv tady vyladíš (vegetace, kamery, nástroje, vzhled vieweru), má hlavní aplikace okamžitě taky. Žádné slučování na konci není potřeba.

Rozdíl je jen v persistence vrstvě (`ViewerAdapter`):

| | Hlavní appka | 3D Lab |
|---|---|---|
| implementace | `react-app/src/pages/ModelsPage/viewerAdapter.ts` (Supabase) | `src/localAdapter.ts` (localStorage) |
| modely | Supabase Storage | lokální soubor (drag&drop) |

## Pravidlo pro vývoj jádra

Soubory v `react-app/src/viewer-core/` nesmí importovat nic z hlavní appky (`@/lib`, `@/stores`, `@/components`…). Vše, co jádro potřebuje od okolí, dostává přes props (`adapter`, `canEdit`, `confirm`). Když budeš přidávat novou funkci, která potřebuje něco ukládat, přidej metodu do `ViewerAdapter` v `viewer-core/adapter.ts` a implementuj ji v obou adaptérech.
