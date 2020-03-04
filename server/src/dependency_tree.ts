import { promises as fs } from "fs";
import * as path from "path";

import { IConnection, Position } from "vscode-languageserver";
import * as ts from "typescript";
import { URI } from "vscode-uri";

import { Bridge } from "./bridge";
import { getDeps } from "../../core/deno_deps";
import { FileWalker } from "../../core/file_walker";
import { ImportMap } from "../../core/import_map";
import { isHttpURL } from "../../core/util";

interface URLDep {
  filepath: string;
  location: { start: Position; end: Position };
}

type DependencyTreeMap = { [key: string]: URLDep[] };

export class DependencyTree {
  constructor(connection: IConnection, private bridge: Bridge) {
    connection.onRequest(
      "getDependencyTreeOfProject",
      this.getDependencyTreeOfProject.bind(this)
    );
  }
  async getDependencyTreeOfProject(uriStr: string): Promise<DependencyTreeMap> {
    const folderUir = URI.parse(uriStr);
    const folder = folderUir.fsPath;

    const depsMap = new Map<string, URLDep[]>();

    const config = await this.bridge.getWorkspaceConfig(uriStr);

    const importMapFilepath = config.import_map
      ? path.isAbsolute(config.import_map)
        ? config.import_map
        : path.resolve(folder, config.import_map)
      : undefined;

    const importMap = ImportMap.create(importMapFilepath);

    const walker = FileWalker.create(folder, {
      exclude: ["node_modules", "bower_components", "vendor", /^\./],
      include: [/\.tsx?$/, /\.jsx?$/]
    });

    for await (const filepath of walker) {
      const fileUri = URI.file(filepath);

      // Parse a file
      const sourceFile = ts.createSourceFile(
        fileUri.fsPath,
        await fs.readFile(fileUri.fsPath, { encoding: "utf8" }),
        ts.ScriptTarget.ESNext,
        false,
        ts.ScriptKind.TSX
      );

      const deps = await getDeps(ts)(sourceFile);

      for (const dep of deps) {
        if (!dep.remote) {
          dep.moduleName = importMap.resolveModule(dep.moduleName);
        }

        if (isHttpURL(dep.moduleName)) {
          const url = dep.moduleName;
          const arr = depsMap.get(url) || [];

          arr.push({ filepath, location: dep.location });

          depsMap.set(url, arr);
        }
      }
    }

    const result: DependencyTreeMap = {};

    for (const [url, files] of depsMap.entries()) {
      result[url] = files;
    }

    return result;
  }
}
