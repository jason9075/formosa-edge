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
          ps.shapely        # polygon ring/hole classification + vertex simplification
          ps.mapbox-earcut  # robust polygon triangulation (handles holes)
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
            echo "Formosa's Edge dev shell — see 'just' for all recipes"
            echo "  Assets : just fetch → convert-100m → tile / buildings / rivers / convert-roads / convert-boundaries"
            echo "  Deploy : just stage → git add public/ → push main"
            echo "  Frontend: just dev (http://localhost:8080) · just build"
          '';
        };
      });
}
