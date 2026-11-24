Optional offline build fallback for Dockerfile.pro: place a clone of
firmware-pro at vendor-src/firmware-pro and submodule checkouts at
vendor-src/modules/<name> to build without GitHub access. Empty by default;
the Dockerfile then fetches from upstream.
