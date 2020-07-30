var path = require('path')
    , fs = require('fs')
    , os = require('os')
    , async = require('async')
    , fse = require('fs-extra')
    , _ = require('underscore')
    , convert = require('./convert')
    , GeneratorError = require('./generator_error');

var PngGenerator = function (generator, document, setup, useSuffixesInFilenames) {
    this.PLUGIN_VERSION = '2.1.0';
    this.VERSION = 1;
    this.AUTHOR = 'photoshop lsr plugin('.concat(this.getPlatform()).concat(') v'.concat(this.PLUGIN_VERSION));
    this.PS_PROFILE_P3 = 'Display P3';
    this.PS_PROFILE_SRGB = 'sRGB IEC61966-2.1';

    this.JSON_PROFILE_P3 = 'display-P3';
    this.JSON_PROFILE_SRGB = 'sRGB';

    this.ROOT_LAYER_ART = 'art';
    this.ROOT_LAYER_ART_P3 = 'art-p3';
    this.ROOT_LAYER_ART_P3_2X = 'art-p3@2x';

    this.generator = generator;
    this.document = document;

    this.maxPreviewHeight = 1000;

    //this.appRoot = path.resolve(__dirname);
    this.documentName = path.basename(document.file, '.psd');
    this.documentDir = path.dirname(document.file);
    this.lsrName = this.documentName + '.lsr';
    var DesktopPath = path.join(process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'], 'Desktop');

    if (this.documentDir === '.') {
        this.documentDir = os.tmpdir();
        this.usingTmpDir = true;
        this.lsrPath = path.join(DesktopPath, this.lsrName);
    } else {
        this.usingTmpDir = false;
        this.lsrPath = path.join(this.documentDir, this.lsrName);
    }

    this.saveDir = path.join(this.documentDir, this.documentName + '-assets-files');
    this.previewDir = path.join(this.saveDir, 'preview');
    this.lsrDir = path.join(this.saveDir, 'uncompressed');
    this.useSuffixesInFilenames = useSuffixesInFilenames;
    if (setup) {
        this._cleanup(this._setup);
    }
};

PngGenerator.prototype.getPlatform = function(){
    return process.platform === 'win32' ? 'Windows' : 'macOS';
};

PngGenerator.prototype.generatePreview = function (needsPreview, done, progressCallback) {
    var self = this;
    this.needsPreview = needsPreview || false;
    if (!needsPreview) {
        log('Skipping Preview');
        done();
    }
    this.validateStructure(_.bind(function (err, layers) {
        if (err) {
            done(err);
        } else {
            this.layers = layers;
            async.eachSeries(this.layers,
                function (layer, done) {
                    self._processLayer(layer, true, function (err) {
                        if (progressCallback) {
                            progressCallback((_.indexOf(self.layers, layer) + 1) / self.layers.length * 100);
                        }
                        done(err);
                    })
                },
                _.bind(function (err) {
                    if (err) {
                        done(err);
                    } else {
                        this._generateMeta(true, done, progressCallback);
                    }
                }, this));
        }
    }, this));
};

PngGenerator.prototype.generateFinal = function (outerdone, progressCallback) {
    var self = this;
    this.validateStructure(_.bind(function (err, layers) {
        if (err) {
            outerdone(err);
        } else {
            this.layers = layers;
            async.eachSeries(this.layers,
                function (layer, done) {
                    self._processLayer(layer, false, function (err) {
                        if (progressCallback) {
                            progressCallback((_.indexOf(self.layers, layer) + 1) / self.layers.length * 100);
                        }
                        if (err) {
                            done(err);
                        } else {
                            done(null);
                        }
                    })
                },
                _.bind(function (err) {
                    if (err) {
                        done(err);
                    } else {
                        this._generateMeta(false, outerdone, progressCallback);
                    }
                }, this));
        }
    }, this));
};

PngGenerator.prototype.validateLayerComps = function (done) {
    var self = this;

    this.validateStructure(function (err, layers) {
        if (err) {
            _.bind(done, self)(err);
        } else {
            var backgroundLayer = _.find(layers, function (layer) {
                return layer.bounds.left <= self.document.bounds.left &&
                    layer.bounds.top <= self.document.bounds.top &&
                    layer.bounds.right >= self.document.bounds.right &&
                    layer.bounds.bottom >= self.document.bounds.bottom;
            });

            if (backgroundLayer) {
                _.bind(done, self)();
            } else {
                _.bind(done, self)(new GeneratorError('previewValidationError', 'A preview couldn’t be generated because there is no background layer, or the background layer isn’t visible.'));
            }
        }
    });
};

PngGenerator.prototype.validateStructure = function (done) {
    var self = this;
    var documentColorProfile = this.document.profile.toLowerCase();

    var rootLayers = _.filter(this.document.layers, function (layer) {
        var layerName = layer.name.toLowerCase();
        return (layer.type === 'layerSection' && layerName === self.ROOT_LAYER_ART) ||
            (layer.type === 'layerSection' && layerName === self.ROOT_LAYER_ART_P3) ||
            (layer.type === 'layerSection' && layerName === self.ROOT_LAYER_ART_P3_2X);
    });

    if (rootLayers.length > 1) {
        return done(new GeneratorError('previewValidationError', 'A preview couldn\'t be generated because there\'s more than one Art, Art-P3, or Art-P3@2x folder in the PSD file.'));
    }

    var rootLayer = this.getRootLayer();

    if (!rootLayer) {
        return done(new GeneratorError('previewValidationError', 'A preview couldn\'t be generated because there\'s no Art, Art-P3, or Art-P3@2x folder in the PSD file.'));
    }

    if (!rootLayer.visible) {
        return done(new GeneratorError('previewValidationError', 'A preview couldn\'t be generated because the Art folder is not visible.'));
    }
    console.log('PSD Profile: '.concat(documentColorProfile));
    console.log('Root Layer name: '.concat(rootLayer.name));

    var allLayers = _.filter(rootLayer.layers, function (layer) {
        var visible = layer.visible;
        var empty = layer.bounds.top === 0 && layer.bounds.left === 0 && layer.bounds.right === 0 && layer.bounds.bottom === 0 && layer.name.indexOf('spacer') === -1;
        return visible && !empty;
    });

    var layers = _.first(allLayers, 5);
    var badNameLayer = _.filter(layers, function (layer) {
        if ((layer.name.indexOf('@') !== -1) || (layer.name.indexOf('/') !== -1) || (layer.name.indexOf(',') !== -1)) {
            return true;
        }
    });

    if (badNameLayer.length > 0) {
        return done(new GeneratorError('previewValidationError', 'An error occurred creating uncompressed assets due to invalid characters in layer name. Layer names cannot contain "@", "," or "/"'));
    }

    var allLayerNames = _.map(layers, function (layer) {
        return layer.name.toLowerCase();
    });

    if (allLayerNames.length !== _.uniq(allLayerNames).length) {
        return done(new GeneratorError('previewValidationError', 'A preview couldn\'t be generated because the names of visible layers or subfolders must be unique.'));
    }

    if (allLayers.length > 5) {
        return done(new GeneratorError('previewValidationError', 'A preview couldn\'t be generated because there are more than five visible layers or folders.'));
    }

    if (layers.length === 0) {
        return done(new GeneratorError('previewValidationError', 'A preview couldn\'t be generated because the Art folder in the PSD file is empty.'));
    }

    if (layers.length <= 1) {
        return done(new GeneratorError('previewValidationError', 'To update the preview, make at least two subfolders or layers visible.'));
    }
    var rootLayerName = rootLayer.name.toLowerCase();

    if (this.document.profile === this.PS_PROFILE_P3) {// is in the p3 profile
        if(rootLayerName === this.ROOT_LAYER_ART){
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file is using the P3 color profile. But the "Art" folder exports images using the sRGB color profile.'));
        }
    }else if(this.document.profile.indexOf(this.PS_PROFILE_SRGB) !== -1) {// is in srgb
        // do nothing because there’s no risk of color loss
    }else if(this.document.profile === 'Untagged RGB'){// no profile managing the file
        if (rootLayerName === this.ROOT_LAYER_ART) {
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file does not have a color profile assigned. But the "Art" folder exports images using the sRGB color profile.'));
        }
        if(rootLayerName === this.ROOT_LAYER_ART_P3){
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file does not have a color profile assigned. But the "Art-P3" folder exports images using the P3 color profile.'));
        }
        if(rootLayerName === this.ROOT_LAYER_ART_P3_2X){
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file does not have a color profile assigned. But the "Art-P3@2x" folder exports images using the P3 color profile.'));
        }
    }else {// not in srgb or p3 color space
        if (rootLayerName === this.ROOT_LAYER_ART) {
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file is not using the sRGB or P3 color profile. But the "Art" folder exports images using the sRGB color profile.'));
        }
        if(rootLayerName === this.ROOT_LAYER_ART_P3){
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file is not using the sRGB or P3 color profile. But the "Art-P3" folder exports images using the P3 color profile.'));
        }
        if(rootLayerName === this.ROOT_LAYER_ART_P3_2X){
            return done(new GeneratorError('previewValidationError', 'Error: Mismatched color space. This PSD file is not using the sRGB or P3 color profile. But the "Art-P3@2x" folder exports images using the P3 color profile.'));
        }
    }

    done(null, layers);
};

PngGenerator.prototype.getRootLayer = function () {
    return _.find(this.document.layers, function (layer) {
        var layerName = layer.name.toLowerCase();
        return layer.type === 'layerSection' &&
            (layerName === this.ROOT_LAYER_ART || layerName === this.ROOT_LAYER_ART_P3 || layerName === this.ROOT_LAYER_ART_P3_2X)
    }, this);
};

PngGenerator.prototype.getRequiredJSONProfile = function () {
    var rootLayerName = this.getRootLayer().name.toLowerCase();
    if (rootLayerName === this.ROOT_LAYER_ART) {
        return this.JSON_PROFILE_SRGB;
    } else if (rootLayerName === this.ROOT_LAYER_ART_P3 || rootLayerName === this.ROOT_LAYER_ART_P3_2X) {
        return this.JSON_PROFILE_P3;
    }
};

PngGenerator.prototype.getRequiredProfile = function () {
    var rootLayerName = this.getRootLayer().name.toLowerCase();
    if (rootLayerName === this.ROOT_LAYER_ART) {
        return this.PS_PROFILE_SRGB;
    } else if (rootLayerName === this.ROOT_LAYER_ART_P3 || rootLayerName === this.ROOT_LAYER_ART_P3_2X) {
        return this.PS_PROFILE_P3;
    }
};

PngGenerator.prototype.getRequiredScale = function () {
    var rootLayerName = this.getRootLayer().name.toLowerCase();
    if (rootLayerName === this.ROOT_LAYER_ART) {
        return '1x';
    } else if (rootLayerName === this.ROOT_LAYER_ART_P3) {
        return '';
    } else if (rootLayerName === this.ROOT_LAYER_ART_P3_2X) {
        return '2x';
    }
};

PngGenerator.prototype._processLayer = function (layer, forPreview, done) {
    this._getPixmap(layer, function (err, pixmap) {
        if (err) {
            done(err);
        } else {
            this._savePixmap(pixmap, layer, forPreview, done);
        }
    });
};

PngGenerator.prototype._getPixmap = function (layer, done) {
    var self = this;
    console.log('get pixmap with profile: '.concat(this.getRequiredProfile()));
    this.generator.getPixmap(this.document.id, layer.id, {
        clipToDocumentBounds: true,
        useFlite:true,
        useICCProfile:this.getRequiredProfile(),
        getICCProfileData:true
    }).then(
        function (pixmap) {
            _.bind(done, self)(null, pixmap);
        },
        function (err) {
            _.bind(done, self)(err)
        }
    ).done();
};

PngGenerator.prototype._savePixmap = function (pixmap, layer, forPreview, done) {
    var self = this;
    var dimensions;
    var layerName = layer.name.toLowerCase();
    console.log('_savePixmap layer name: '.concat(layerName));
    if(layerName.indexOf('spacer') !== -1){
        dimensions = {
            left: 0,
            top: 0,
            right: 1,
            bottom: 1
        };
    }else{
        dimensions = {
            left: parseFloat(pixmap.bounds.left.toFixed()),
            top: parseFloat(pixmap.bounds.top.toFixed()),
            right: parseFloat(pixmap.bounds.right.toFixed()),
            bottom: parseFloat(pixmap.bounds.bottom.toFixed())
        };
    }
    layer.calculatedDimensions = {
        x: dimensions.left,
        y: dimensions.top,
        width: dimensions.right - dimensions.left,
        height: dimensions.bottom - dimensions.top
    };
    var previewSettings = {
        format: 'png',
        ppi: self.document.resolution,
        useFlite:true
    };
    var generateOutput = function (rootDir, layer, options, done) {
        var saveDir = path.join(rootDir, self._simpleLayerName(layer) + '.imagestacklayer', 'Content.imageset');
        var filePath = path.join(saveDir, self.getFilenameForArtLayerType(layer));
        console.log('saveDir: '.concat(saveDir));
        console.log('filePath: '.concat(filePath));

        if(layerName.indexOf('spacer') !== -1) {
            var rootLayerName = self.getRootLayer().name.toLowerCase();
            var spacerName = './spacer_p3.png';
            if (rootLayerName === this.ROOT_LAYER_ART) {
                spacerName = './spacer.png'
            }
            fse.mkdirs(saveDir, function () {
                fs.createReadStream(path.resolve(__dirname,spacerName)).pipe(fs.createWriteStream(filePath));
                done();
            });
        }else{
            fse.mkdirs(saveDir, function () {
                self.savePixmap(pixmap, filePath, options, done)
                    .thenResolve(path)
                    .catch(function (err) {
                        // If an error occurred, clean up the file.
                        try {
                            fileStream.close();
                        } catch (e) {
                            console.error("Error when closing file stream", e);
                        }
                        try {
                            if (fs.existsSync(path)) {
                                fs.unlinkSync(path);
                            }
                        } catch (e) {
                            console.error("Error when deleting file", path, e);
                        }
                        // Propagate the error.
                        throw err;
                    });
            });
        }
    };
    if(forPreview){
        console.error("for preview: "+forPreview);
        if (self.needsPreview) {
            generateOutput(self.previewDir, layer, _.extend({}, previewSettings, {_scale:1}), done);
        }
    }else{
        generateOutput(self.lsrDir, layer, _.extend({}, previewSettings, {}), done);
    }
};

PngGenerator.prototype.savePixmap = function (pixmap, path, settings, done) {
    var self = this;
    var fs = require("fs");

    // Open a stream to the output file.
    var fileStream = fs.createWriteStream(path);

    fileStream.on("close", function () {
        done();
    });
    // Stream the pixmap into the file and resolve with path when successful.
    return self.streamPixmap(pixmap, fileStream, settings)
        .thenResolve(path)
        .catch(function (err) {
            // If an error occurred, clean up the file.
            try {
                fileStream.close();
            } catch (e) {
                console.error("Error when closing file stream", e);
            }
            try {
                if (fs.existsSync(path)) {
                    fs.unlinkSync(path);
                }
            } catch (e) {
                console.error("Error when deleting file", path, e);
            }

            // Propagate the error.
            throw err;
        });
};

PngGenerator.prototype.getFilenameForArtLayerType = function (layer) {
    if(this.useSuffixesInFilenames === 'false'){
        return this._simpleLayerName(layer) + '.png';
    }else if(this.getRootLayer().name.toLowerCase() === this.ROOT_LAYER_ART){
        return this._simpleLayerName(layer) + '-srgb.png';
    }else if (this.getRootLayer().name.toLowerCase() === this.ROOT_LAYER_ART_P3) {
        return this._simpleLayerName(layer) + '-p3.png';
    }else if (this.getRootLayer().name.toLowerCase() === this.ROOT_LAYER_ART_P3_2X) {
        return this._simpleLayerName(layer) + '-p3@2x.png';
    }
};

PngGenerator.prototype._generateMeta = function (preview, done, progress) {
    var self = this;
    var progressCallback = progress;
    var forPreview = preview;
    var lsrMeta = {
        layers: [],
        info: {
            version: this.VERSION,
            author: this.AUTHOR
        },
        properties: {
            canvasSize: {
                width: this.document.bounds.right,
                height: this.document.bounds.bottom
            }
        }
    };

    var lsrStructure = {
        document: {
            dimensions: {
                width: this.document.bounds.right,
                height: this.document.bounds.bottom
            }
        },
        layers: []
    };

    var profileToEmbed = this.getRequiredJSONProfile();
    var scaleToEmbed = this.getRequiredScale();

    if (this.document.profile.toLowerCase() !== this.getRequiredProfile().toLowerCase()) {
        console.log('Modifying image profile for exported images to '.concat(this.getRequiredProfile()))
    }

    var _generateLayerInfo = function (layer, cb) {
        var htmlCenter = {
            x: layer.calculatedDimensions.x + layer.calculatedDimensions.width / 2,
            y: layer.calculatedDimensions.y + layer.calculatedDimensions.height / 2
        };
        var imageStackMeta = {
            info: {
                version: self.VERSION,
                author: self.AUTHOR
            },
            properties: {
                "frame-size": {
                    width: layer.calculatedDimensions.width,
                    height: layer.calculatedDimensions.height
                },
                "frame-center": htmlCenter
            }
        };
        var imageSetMeta = {
            info: {
                'version': self.VERSION,
                'author': self.AUTHOR
            },
            images: [{
                'idiom': 'universal',
                'filename': this.getFilenameForArtLayerType(layer),
                'display-gamut': profileToEmbed
            }]
        };
        var imagePath = path.join(this._simpleLayerName(layer) + '.imagestacklayer', 'Content.imageset', this.getFilenameForArtLayerType(layer));// for preview only
        var props = {"frame-center": htmlCenter, "scale": scaleToEmbed};
        if (scaleToEmbed !== '') {
            imageSetMeta.images[0].scale = scaleToEmbed;
        } else {
            props = {"frame-center": htmlCenter};
        }
        lsrStructure.layers.push({
            dimensions: _.extend({}, imageStackMeta.properties, props),
            path: imagePath,
            name: this._simpleLayerName(layer)
        });

        var imageStackMetaPath = path.join(self.lsrDir, this._simpleLayerName(layer) + '.imagestacklayer', 'Contents.json');
        var imageSetMetaPath = path.join(self.lsrDir, this._simpleLayerName(layer) + '.imagestacklayer', 'Content.imageset', 'Contents.json');

        if (forPreview) {
            imageStackMetaPath = path.join(self.previewDir, this._simpleLayerName(layer) + '.imagestacklayer', 'Contents.json');
            imageSetMetaPath = path.join(self.previewDir, this._simpleLayerName(layer) + '.imagestacklayer', 'Content.imageset', 'Contents.json');
        }

        fs.writeFile(imageStackMetaPath, JSON.stringify(imageStackMeta, undefined, 2), _.bind(function (err) {
            if (err) {
                cb(err);
            } else {
                fs.writeFile(imageSetMetaPath, JSON.stringify(imageSetMeta, undefined, 2), _.bind(function (err) {
                    if (err) {
                        cb(err);
                    } else {
                        lsrMeta.layers.push({filename: this._simpleLayerName(layer) + ".imagestacklayer"});
                        progressCallback((_.indexOf(this.layers, layer) + 1) / this.layers.length * 100);
                        cb(null);
                    }
                }, this));
            }
        }, this));
    };

    var lsrStructurePath = path.join(this.previewDir, 'Contents.json');
    var lsrMetaPath = path.join(this.lsrDir, 'Contents.json');

    async.eachSeries(this.layers, _.bind(_generateLayerInfo, this), _.bind(function (err) {
        if (err) {
            done(err);
        } else {
            if (forPreview) {
                fs.writeFile(lsrStructurePath, JSON.stringify(lsrStructure, undefined, 2), function (err) {
                    done(err);
                });
            } else {
                fs.writeFile(lsrMetaPath, JSON.stringify(lsrMeta, undefined, 2), function (err) {
                    done(err);
                });
            }
        }
    }, this));
};

PngGenerator.prototype._simpleLayerName = function (layer) {
    // lowercase
    // simplify string
    // max length = 128 chars = 124 + .png
    // normalize to nfc
    var maxLength = 124;

    // Windows does not support file paths longer than 260 chars
    // This is causing invalid output of paths, so use shorter file names
    // See:
    // http://stackoverflow.com/questions/265769/maximum-filename-length-in-ntfs-windows-xp-and-windows-vista
    // http://windows.microsoft.com/en-us/windows/file-names-extensions-faq
    if (process.platform === 'win32') {
        maxLength = 30;
    }
    return layer.name.toLowerCase().replace(/\W/g, '-').substring(0, maxLength).normalize('NFC');
};

PngGenerator.prototype._cleanup = function (done) {
    fse.remove(this.saveDir, _.bind(done, this));
};

PngGenerator.prototype._setup = function () {
    var self = this;

    fse.mkdirs(self.lsrDir, function () {
        if (self.needsPreview) {
            fse.mkdirs(self.previewDir, function () {
            });
        }
    });
};

PngGenerator.prototype.streamPixmap = function (pixmap, outputStream, settings) {
    this.generator._parsePixmapProperties(pixmap);
    this.generator._parsePixmapSaveSettings(settings);
    return convert.streamPixmap(this.generator._paths, pixmap, outputStream, settings);
};

var log = function (message) {
    console.log('-----------------------------------------------------');
    console.log('-> ' + message);
    console.log('-----------------------------------------------------');
};

module.exports = PngGenerator;
