DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
export DEVELOPER_DIR

BUILD_DIR := build
APP_PATH := $(BUILD_DIR)/Build/Products/Release/MDGEM.app

.PHONY: all web project build run open clean

all: build

web:
	cd build-web && npm install --no-fund --no-audit && npm run build

project: web
	xcodegen generate

build: project
	xcodebuild \
		-project MDReader.xcodeproj \
		-scheme MDReader \
		-configuration Release \
		-derivedDataPath $(BUILD_DIR) \
		CODE_SIGN_IDENTITY="-" \
		CODE_SIGNING_REQUIRED=NO \
		CODE_SIGNING_ALLOWED=NO \
		build

run: build
	open $(APP_PATH) --args -NSDocumentRevisionsDebugMode YES

open-sample: build
	open -a $(APP_PATH) Samples/test-sample.md

clean:
	rm -rf $(BUILD_DIR) MDReader.xcodeproj Resources/vendor build-web/node_modules
