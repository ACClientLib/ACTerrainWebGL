export interface DatSetCatalogEntry {
  id: string;
  name: string;
  version: string;
}

export interface ServerCatalogEntry {
  id: string;
  name: string;
  datId: string;
  datVersion: string;
  version: string;
}

export interface DatasetCatalog {
  version: number;
  defaultDatId: string | null;
  defaultServerId: string | null;
  dats: DatSetCatalogEntry[];
  servers: ServerCatalogEntry[];
}

export interface DatasetSelection {
  dat: DatSetCatalogEntry;
  server?: ServerCatalogEntry;
}

export async function loadDatasetCatalog(
  baseUrl = import.meta.env.VITE_ACTERRAIN_API_URL ??
    "https://terrainapi.utilitybelt.me/",
): Promise<DatasetCatalog> {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const response = await fetch(
    new URL("v3/catalog", new URL(root || "/", window.location.href)),
  );
  if (!response.ok)
    throw new Error(`ACTerrain catalog returned HTTP ${response.status}`);
  const catalog = (await response.json()) as DatasetCatalog;
  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.dats) ||
    !Array.isArray(catalog.servers) ||
    catalog.dats.length === 0
  )
    throw new Error("Invalid ACTerrain dataset catalog");
  return catalog;
}

export function selectDataset(catalog: DatasetCatalog): DatasetSelection {
  const requested = new URLSearchParams(window.location.search).get("dataset") ?? settings.data.dataset;
  const [kind, id] = requested?.split(":", 2) ?? [];
  const server =
    kind === "server"
      ? catalog.servers.find((item) => item.id === id)
      : requested === null && catalog.defaultServerId
        ? catalog.servers.find((item) => item.id === catalog.defaultServerId)
        : undefined;
  if (server) {
    const dat = catalog.dats.find((item) => item.id === server.datId);
    if (!dat)
      throw new Error(
        `Server '${server.id}' references missing DAT set '${server.datId}'`,
      );
    return { dat, server };
  }
  const datId =
    kind === "dat" ? id : catalog.defaultDatId ?? catalog.dats[0].id;
  return {
    dat:
      catalog.dats.find((item) => item.id === datId) ?? catalog.dats[0],
  };
}

export function populateDatasetSelector(
  element: HTMLSelectElement,
  catalog: DatasetCatalog,
  selection: DatasetSelection,
  beforeNavigate?: () => void,
): void {
  const dats = document.createElement("optgroup");
  dats.label = "DAT Sets";
  for (const dat of catalog.dats) {
    const option = document.createElement("option");
    option.value = `dat:${dat.id}`;
    option.textContent = dat.name;
    dats.append(option);
  }
  const servers = document.createElement("optgroup");
  servers.label = "Servers";
  for (const server of catalog.servers) {
    const option = document.createElement("option");
    option.value = `server:${server.id}`;
    option.textContent = server.name;
    servers.append(option);
  }
  element.replaceChildren(dats, servers);
  element.value = selection.server
    ? `server:${selection.server.id}`
    : `dat:${selection.dat.id}`;
  element.addEventListener("change", () => {
    settings.data.dataset = element.value;
    beforeNavigate?.();
    const url = new URL(window.location.href);
    url.searchParams.set("dataset", element.value);
    window.location.assign(url.toString());
  });
}
import * as settings from "../settings";
