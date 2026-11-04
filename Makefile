ARCHES := x86 arm
TS_CHECK := npx tsc -p tsconfig.startos.json --noEmit
# overrides to s9pk.mk must precede the include statement
include node_modules/@start9labs/start-sdk/s9pk.mk
