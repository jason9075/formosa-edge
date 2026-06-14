{
  description = "DTM Visualizer — Taiwan LiDAR terrain tiles to GLB + Three.js frontend";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        python = pkgs.python313.withPackages (ps: [
          ps.numpy
          ps.pyshp
          ps.pyproj
        ]);
      in
      {
        devShells.default = pkgs.mkShell {
          name = "dtm-visualizer";

          packages = [
            python
            pkgs.nodejs_22     # Vite + Three.js frontend
            pkgs.bun           # package manager
            pkgs.just          # task runner
            pkgs.gdal          # gdalinfo / gdal_translate for tile inspection
          ];

          shellHook = ''
            echo "DTM Visualizer dev shell"
            echo "  just convert-fast   — generate 40m GLB (quick preview)"
            echo "  just convert        — generate 20m GLB (full resolution)"
            echo "  just install        — install npm dependencies"
            echo "  just dev            — start Three.js frontend on :8080"
          '';
        };
      });
}
