/// <reference path="../../typings/globals/node/index.d.ts" />
/// <reference path="../../typings/modules/mkdirp/index.d.ts" />

import fs = require('fs');
import path = require('path');
import mkdirp = require('mkdirp');
import logger from './logger';
let inflector = require('inflector-js');

function trimDx(value: string) {
    return trimPrefix('dx-', value);
}

function trimPrefix(prefix: string, value: string) {
    return value.substr(prefix.length);
}

export interface IObjectStore {
    read(name: string): Object;
    write(name: string, data: Object): void;
}

export class FSObjectStore implements IObjectStore {
    private _encoding = 'utf8';
    read(filePath) {
        logger('Read from file: ' + filePath);
        let dataString = fs.readFileSync(filePath, this._encoding);
        logger('Parse data');
        return JSON.parse(dataString);
    }
    write(filePath, data) {
        logger('Write data to file ' + filePath);
        let dataString = JSON.stringify(data, null, 4);
        fs.writeFileSync(filePath, dataString, { encoding: this._encoding });
    }
}

export default class DXComponentMetadataGenerator {
    constructor(private _store?: IObjectStore) {
        if (!this._store) {
            this._store = new FSObjectStore();
        }
    }
    generate(config) {
        let metadata = this._store.read(config.sourceMetadataFilePath),
            widgetsMetadata = metadata['Widgets'],
            allNestedComponents = [];

        mkdirp.sync(config.outputFolderPath);
        mkdirp.sync(path.join(config.outputFolderPath, config.nestedPathPart));
        mkdirp.sync(path.join(config.outputFolderPath, config.nestedPathPart, config.basePathPart));

        for (let widgetName in widgetsMetadata) {
            let widget = widgetsMetadata[widgetName],
                nestedComponents = [];

            if (!widget.Module) {
                logger('Skipping metadata for ' + widgetName);
                continue;
            }

            logger('Generate metadata for ' + widgetName);

            let isTranscludedContent = widget.IsTranscludedContent,
                isExtension = widget.IsExtensionComponent || false,
                className = inflector.camelize(widgetName),
                dasherizedWidgetName = inflector.dasherize(inflector.underscore(widgetName)),
                outputFilePath = path.join(config.outputFolderPath, trimDx(dasherizedWidgetName) + '.json'),
                events = [],
                changeEvents = [],
                properties = [],
                isEditor = Object.keys(widget.Options).indexOf('value') !== -1;

            for (let optionName in widget.Options) {
                let option = widget.Options[optionName];

                if (option.IsEvent) {
                    let eventName = inflector.camelize(optionName.substr('on'.length), true);

                    events.push({
                        emit: optionName,
                        subscribe: eventName
                    });
                } else {
                    let property: any = {
                        name: optionName,
                        type: 'any'
                    };

                    if (!!option.IsCollection || !!option.IsDataSource) {
                        property.isCollection = true;
                    }

                    properties.push(property);

                    changeEvents.push({
                        emit: optionName + 'Change'
                    });

                    let components = this.generateComplexOptionByType(metadata, option, optionName, []);
                    nestedComponents = nestedComponents.concat(...components);
                }
            }

            let allEvents = events.concat(changeEvents);
            let widgetNestedComponents = nestedComponents
                .reduce((result, component) => {
                    if (result.filter(c => c.className === component.className).length === 0) {
                        result.push({
                            path: component.path,
                            propertyName: component.propertyName,
                            className: component.className,
                            isCollection: component.isCollection,
                            hasTemplate: component.hasTemplate
                        });
                    }

                    return result;
                }, []);

            let widgetMetadata = {
                className: className,
                widgetName: widgetName,
                isTranscludedContent: isTranscludedContent,
                isExtension: isExtension,
                selector: dasherizedWidgetName,
                events: allEvents,
                properties: properties,
                isEditor: isEditor,
                module: 'devextreme/' + widget.Module,
                nestedComponents: widgetNestedComponents
            };

            logger('Write metadata to file ' + outputFilePath);
            this._store.write(outputFilePath, widgetMetadata);

            allNestedComponents = allNestedComponents.concat(...nestedComponents);
        }

        this.generateNestedOptions(config, allNestedComponents);
    }

    private generateComplexOptionByType(metadata, option, optionName, complexTypes) {
        if (option.Options) {
            return this.generateComplexOption(metadata, option.Options, optionName, complexTypes, option);
        } else if (option.ComplexTypes && option.ComplexTypes.length === 1) {
            if (complexTypes.indexOf(complexTypes[complexTypes.length - 1]) !== complexTypes.length - 1) {
                return;
            }

            let complexType = option.ComplexTypes[0];
            let externalObject = metadata.ExtraObjects[complexType];
            if (externalObject) {
                let nestedOptions = externalObject.Options;
                let nestedComplexTypes = complexTypes.concat(complexType);

                let components = this.generateComplexOption(metadata, nestedOptions, optionName, nestedComplexTypes, option);
                components[0].baseClass = (option.IsCollection ? 'Dxc' : 'Dxo') + complexType;
                components[0].basePath = inflector.dasherize(inflector.underscore(complexType));
                return components;
            } else {
                logger('WARN: missed complex type: ' + complexType);
            }
        }
    }

    private generateComplexOption(metadata, nestedOptions, optionName, complexTypes, option) {
        if (!nestedOptions || !Object.keys(nestedOptions).length) {
            return;
        }

        let pluralName = optionName;
        if (option.IsCollection && optionName === option.SingularName) {
            pluralName += 'Collection';
        }

        let singularName = option.SingularName || pluralName,
            underscoreSingular = inflector.underscore(singularName).split('.').join('_'),
            underscorePlural = inflector.underscore(pluralName).split('.').join('_'),
            prefix = (option.IsCollection ? 'dxc' : 'dxo') + '_',
            underscoreSelector = prefix + (option.IsCollection ? underscoreSingular : underscorePlural),
            selector = inflector.dasherize(underscoreSelector),
            path = inflector.dasherize(underscorePlural);

        let complexOptionMetadata: any = {
            className: inflector.camelize(underscoreSelector),
            selector:  selector,
            optionName: optionName,
            properties: [],
            path: path,
            propertyName: optionName,
            isCollection: option.IsCollection,
            hasTemplate: option.Options && option.Options.template && option.Options.template.IsTemplate
        };

        let nestedComponents = [complexOptionMetadata];

        for (let optName in nestedOptions) {
            if (optName === 'template' && option.Options[optName].IsTemplate) {
                continue;
            };

            let property: any = {
                name: optName
            };
            complexOptionMetadata.properties.push(property);

            let components = this.generateComplexOptionByType(metadata, nestedOptions[optName], optName, complexTypes);

            nestedComponents = nestedComponents.concat(...components);
        }

        return nestedComponents;
    }

    private generateNestedOptions(config, metadata) {
        let normalizedMetadata = metadata
            .reduce((result, component) => {
                let existingComponent = result.filter(c => c.className === component.className)[0];

                if (!existingComponent) {
                    result.push(component);
                } else {
                    existingComponent.properties = existingComponent.properties
                        .concat(...component.properties)
                        .reduce((properties, property) => {
                            if (properties.filter(p => p.name === property.name).length === 0) {
                                properties.push(property);
                            }

                            return properties;
                        }, []);

                    existingComponent.baseClass = existingComponent.baseClass || component.baseClass;
                    existingComponent.basePath = existingComponent.basePath || component.basePath;
                }

                return result;
            }, []);

        normalizedMetadata
            .reduce((result, component) => {
                let existingComponent = result.filter(c => c.className === component.baseClass)[0];
                if (!existingComponent && component.baseClass) {
                    result.push({
                        properties: component.properties,
                        className: component.baseClass,
                        path: component.basePath
                    });
                }

                return result;
            }, [])
            .forEach(componet => {
                let outputFilePath = path.join(config.outputFolderPath,
                    config.nestedPathPart, config.basePathPart, componet.path + '.json');
                this._store.write(outputFilePath, componet);
            });

        normalizedMetadata
            .map((component) => {
                if (component.baseClass) {
                    delete component.properties;
                    component.basePath = './base/' + component.basePath;
                } else {
                    component.baseClass = component.isCollection ? 'CollectionNestedOption' : 'NestedOption';
                    component.basePath = '../../core/nested-option';
                    component.hasSimpleBaseClass = true;
                }

                return component;
            })
            .forEach(componet => {
                let outputFilePath = path.join(config.outputFolderPath, config.nestedPathPart, componet.path + '.json');
                this._store.write(outputFilePath, componet);
            });
    }
}
