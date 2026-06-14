{
  description = "DTM Visualizer — Taiwan LiDAR terrain tiles to GLB";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        python = pkgs.python313.withPackages (ps: [
          ps.numpy
        ]);
      in
      {
        devShells.default = pkgs.mkShell {
          name = "dtm-visualizer";

          packages = [
            python
            pkgs.bun           # frontend dev (Three.js)
            pkgs.just          # task runner
            pkgs.gdal          # optional: gdal_translate / gdalinfo for inspection
          ];

          shellHook = ''
            echo "DTM Visualizer dev shell"
            echo "  just convert-fast   — 40m GLB (quick preview)"
            echo "  just convert        — 20m GLB (full resolution)"
          '';
        };
      });
}
