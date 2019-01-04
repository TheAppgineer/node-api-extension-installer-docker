// Copyright 2019 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var Docker = require('dockerode');

var docker;
var docker_version;
var installed = {};
var states = {};

function ApiExtensionInstallerDocker(cb) {
    docker = new Docker({ socketPath: '/var/run/docker.sock' });

    docker.version((err, version) => {
        if (!err && version.Version) {
            if (version.Os == 'linux') {
                docker_version = version;

                _query_installs((err, installed) => {
                    cb && cb(err, installed);
                });
            } else {
                cb && cb('Host OS not supported: ' + version.Os);
            }
        } else {
            cb && cb('Docker not found');
        }
    });
}

ApiExtensionInstallerDocker.prototype.get_status = function(name) {
    let version;
    let state;

    if (name) {
        version = installed[name];
    } else if (docker_version) {
        version = docker_version.Version;
    }

    state = (version ? 'installed' : 'not_installed');

    if (state == 'installed') {
        // Get container state
        state = states[name];

        if (state == 'created' || state == 'exited') {
            // Convert Docker specific states to generic stopped state
            state = 'stopped';
        }
    }

    return {
        state:   state,
        version: version,
        logging: undefined
    };
}

ApiExtensionInstallerDocker.prototype.get_name = function(image) {
    return _split(image.repo).repo;
}

ApiExtensionInstallerDocker.prototype.install = function(image, cb) {
    if (docker_version && image && image.tags[docker_version.Arch]) {
        const repo_tag_string = image.repo + ':' + image.tags[docker_version.Arch];

        _install(repo_tag_string, image.config, cb);
    } else {
        cb && cb('No image available for "' + docker_version.Arch + '" architecture');
    }
}

ApiExtensionInstallerDocker.prototype.query_updates = function(cb, name) {
    if (name) {
        let updates = {};

        if (installed[name]) {
            updates[name] = installed[name];
        }

        cb && cb(updates);
    } else {
        cb && cb(installed);
    }
}

ApiExtensionInstallerDocker.prototype.update = function(name, cb) {
    const container = docker.getContainer(name);

    container.inspect((err, info) => {
        if (info) {
            const image_name = info.Config.Image;
            let config = info.Config;
            config.HostConfig = info.HostConfig;

            container.remove((err) => {
                if (err) {
                    cb && cb(err);
                } else {
                    _install(image_name, config, cb);
                }
            });
        } else {
            cb && cb(err);
        }
    });
}

ApiExtensionInstallerDocker.prototype.uninstall = function(name, cb) {
    const container = docker.getContainer(name);

    container.inspect((err, info) => {
        if (info) {
            const image_name = info.Config.Image;

            container.remove((err) => {
                if (err) {
                    cb && cb(err);
                } else {
                    docker.getImage(image_name).remove((err) => {
                        if (err) {
                            cb && cb(err);
                        } else {
                            _query_installs(cb);
                        }
                    });
                }
            });
        } else {
            cb && cb(err);
        }
    });
}

ApiExtensionInstallerDocker.prototype.start = function(name) {
    const container = docker.getContainer(name);

    container.start((err) => {
        container.inspect((err, info) => {
            if (info) {
                states[name] = info.State.Status;
            }
        });
    });
}

ApiExtensionInstallerDocker.prototype.stop = function(name, cb) {
    const container = docker.getContainer(name);

    container.stop((err) => {
        container.inspect((err, info) => {
            if (info) {
                states[name] = info.State.Status;
            }

            cb && cb();
        });
    });
}

ApiExtensionInstallerDocker.prototype.terminate = function(name, cb) {
    ApiExtensionInstallerDocker.prototype.stop.call(this, name, () => {
        if (states[name] == 'exited') {
            states[name] = 'terminated';
        }

        cb && cb();
    });
}

function _install(repo_tag_string, config, cb) {
    docker.pull(repo_tag_string, (err, stream) => {
        if (err) {
            cb && cb(err);
        } else {
            docker.modem.followProgress(stream, /* onFinished */ (err, output) => {
                config.name  = _split(repo_tag_string).repo;
                config.Image = repo_tag_string;

                docker.createContainer(config, (err, container) => {
                    if (err) {
                        cb && cb(err);
                    } else {
                        _query_installs(cb, repo_tag_string);
                    }
                });
            });
        }
    });
}

function _query_installs(cb, name) {
    let options;

    if (name) {
        options = {
            filters: { reference: [name] }
        };
    }

    docker.listImages(options, (err, images) => {
        if (err) {
            cb && cb(err);
        } else {
            let tag;

            images.forEach((image_info) => {
                image_info.RepoTags.forEach((repo_tag) => {
                    const fields = _split(repo_tag);

                    tag = fields.tag;
                    installed[fields.repo] = tag;
                });
            });

            _get_containers((err, containers) => {
                containers.forEach((container) => {
                    if (name) {
                        if (states[name] != 'terminated') {
                            states[name] = container.State.toLowerCase();
                        }
                    } else {
                        states[container.Names[0].replace('/', '')] = container.State.toLowerCase();
                    }
                });

                cb && cb(err, (name ? tag : installed));
            }, name);
        }
    });
}

function _get_containers(cb, name) {
    let options = { all: true };

    if (name) {
        options.filters = { name: [name] };
    }

    docker.listContainers(options, (err, containers) => {
        cb && cb(err, containers);
    });
}

function _split(repo_tag) {
    const fields = repo_tag.split(':');
    let repo = fields[0].split('/');
    let username;
    let tag;

    if (fields.length > 1) {
        tag = fields[1];
    }

    if (repo.length > 1) {
        username = repo[0];
        repo = repo[1];
    } else {
        repo = repo[0];
    }

    return {
        full_repo: fields[0],
        username : username,
        repo: repo,
        tag: tag
    };
}

exports = module.exports = ApiExtensionInstallerDocker;