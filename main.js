"use strict";

const utils = require("@iobroker/adapter-core");
const http = require("http");

class Autodarts extends utils.Adapter {
	constructor(options) {
		super({
			...options,
			name: "autodarts",
		});

		this.on("ready", this.onReady.bind(this));
		this.on("unload", this.onUnload.bind(this));

		this.pollTimer = null;
		this.lastThrowsCount = 0; // Anzahl Darts im aktuellen Visit
		this.lastSignature = ""; // Verhindert doppelte Verarbeitung gleicher Würfe
		this.offline = false;
		this.versionTimer = null; // Timer für Versions- und Config-Abfrage
	}

	async onReady() {
		this.log.info("Autodarts adapter started");

		// Defaults aus io-package.json absichern
		this.config.host ??= "127.0.0.1";
		this.config.port ??= 3180;
		this.config.interval ??= 1000;
		// eslint-disable-next-line jsdoc/check-tag-names
		/** @ts-expect-error tripleMinScore is defined in io-package.json but not in AdapterConfig */
		this.config.tripleMinScore ??= 1; // Mindestpunktzahl für Triple-Flag

		// Visit-Struktur anlegen
		await this.setObjectNotExistsAsync("visit", {
			type: "channel",
			common: {
				name: {
					en: "Current visit",
					de: "Aktuelle Aufnahme",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("visit.score", {
			type: "state",
			common: {
				name: {
					en: "Visit score (Total of 3 darts)",
					de: "Aufnahme (Summe dreier Darts)",
				},
				type: "number",
				role: "value",
				read: true,
				write: false,
				desc: {
					en: "Total of the last complete visit",
					de: "Summe der letzten vollständigen Aufnahme",
				},
			},
			native: {},
		});

		// Throw-Channel und States
		await this.setObjectNotExistsAsync("throw", {
			type: "channel",
			common: {
				name: {
					en: "Current throw",
					de: "Aktueller Wurf",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("throw.current", {
			type: "state",
			common: {
				name: {
					en: "Current dart score",
					de: "Punkte aktueller Pfeil",
				},
				type: "number",
				role: "value",
				read: true,
				write: false,
				desc: {
					en: "Score of the last dart",
					de: "Punktzahl des letzten Pfeils",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("throw.isTriple", {
			type: "state",
			common: {
				name: {
					en: "Triple hit",
					de: "Triple getroffen",
				},
				type: "boolean",
				role: "indicator",
				read: true,
				write: false,
				desc: {
					en: "true if the last dart hit a triple segment (and passes score threshold)",
					de: "true, wenn der letzte Pfeil ein Triple-Segment getroffen hat (und die Punktschwelle erfüllt)",
				},
			},
			native: {},
		});

		// Online-Datenpunkt
		await this.setObjectNotExistsAsync("online", {
			type: "state",
			common: {
				name: {
					en: "Autodarts board online",
					de: "Autodarts Board online",
				},
				type: "boolean",
				role: "indicator.reachable",
				read: true,
				write: false,
				desc: {
					en: "true = Board reachable, false = Board not reachable",
					de: "true = Board erreichbar, false = Board nicht erreichbar",
				},
			},
			native: {},
		});

		// System-Channel und BoardVersion-Datenpunkt anlegen
		await this.setObjectNotExistsAsync("system", {
			type: "channel",
			common: {
				name: {
					en: "Information about the system",
					de: "Informationen zum System",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("system.boardVersion", {
			type: "state",
			common: {
				name: {
					en: "Board manager version",
					de: "Version des Board-Manager",
				},
				type: "string",
				role: "info.version",
				read: true,
				write: false,
				desc: {
					en: "Version of the board manager",
					de: "Version des Board-Manager",
				},
			},
			native: {},
		});

		// Kamera-Infos als JSON-States
		await this.setObjectNotExistsAsync("system.cam0", {
			type: "state",
			common: {
				name: {
					en: "Camera 0 config",
					de: "Kamera 0 Konfiguration",
				},
				type: "string",
				role: "json",
				read: true,
				write: false,
				desc: {
					en: "JSON with camera 0 parameters (width, height, fps)",
					de: "JSON mit Kamera-0-Parametern (width, height, fps)",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("system.cam1", {
			type: "state",
			common: {
				name: {
					en: "Camera 1 config",
					de: "Kamera 1 Konfiguration",
				},
				type: "string",
				role: "json",
				read: true,
				write: false,
				desc: {
					en: "JSON with camera 1 parameters (width, height, fps)",
					de: "JSON mit Kamera-1-Parametern (width, height, fps)",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("system.cam2", {
			type: "state",
			common: {
				name: {
					en: "Camera 2 config",
					de: "Kamera 2 Konfiguration",
				},
				type: "string",
				role: "json",
				read: true,
				write: false,
				desc: {
					en: "JSON with camera 2 parameters (width, height, fps)",
					de: "JSON mit Kamera-2-Parametern (width, height, fps)",
				},
			},
			native: {},
		});

		// Zustand zurücksetzen
		this.lastThrowsCount = 0;
		this.lastSignature = "";

		// Polling starten
		this.pollTimer = setInterval(() => this.fetchState(), this.config.interval);
		this.fetchState();

		// Boardmanager-Version und Kameras abfragen und alle 5 Minuten aktualisieren
		this.fetchVersion();
		this.fetchConfig();
		this.versionTimer = setInterval(
			() => {
				this.fetchVersion();
				this.fetchConfig();
			},
			5 * 60 * 1000,
		);
	}

	/**
	 * Punkte eines Dart berechnen
	 *
	 * @param {object} dart - Ein Dart-Objekt aus Autodarts throws
	 * @returns {number} Punkte
	 */
	calcScore(dart) {
		if (!dart?.segment) {
			return 0;
		}
		return (dart.segment.number || 0) * (dart.segment.multiplier || 0);
	}

	/**
	 * Autodarts API abfragen und Visit-Summe schreiben
	 */
	fetchState() {
		const options = {
			host: this.config.host,
			port: this.config.port,
			path: "/api/state",
			method: "GET",
			timeout: 1500,
		};

		const req = http.request(options, res => {
			let data = "";

			res.on("data", chunk => (data += chunk));
			res.on("end", () => {
				this.offline = false;
				this.setState("online", true, true); // Server erreichbar

				try {
					const state = JSON.parse(data);

					// Nur weiter, wenn throws existieren, Array ist und nicht leer
					if (!state.throws || !Array.isArray(state.throws) || state.throws.length === 0) {
						return;
					}

					const currentThrows = state.throws;
					const currentCount = currentThrows.length;

					// Prüfen, ob sich die Würfe geändert haben
					const signature = JSON.stringify(
						currentThrows.map(d => ({
							name: d.segment?.name || "",
							mult: d.segment?.multiplier || 0,
						})),
					);

					if (signature === this.lastSignature) {
						return;
					}
					this.lastSignature = signature;

					// letzten Dart in States schreiben
					const lastDart = currentThrows[currentThrows.length - 1];
					const score = this.calcScore(lastDart);

					// Konfigurierter Mindestwert für Triple-Flag
					// eslint-disable-next-line jsdoc/check-tag-names
					/** @ts-expect-error tripleMinScore is defined in io-package.json but not in AdapterConfig */
					const minScore = Number(this.config.tripleMinScore) || 0;

					// Triple nur, wenn multiplier === 3 UND score >= minScore
					const isTriple = !!lastDart?.segment && lastDart.segment.multiplier === 3 && score >= minScore;

					this.setState("throw.current", { val: score, ack: true });
					this.setState("throw.isTriple", { val: isTriple, ack: true });

					// Nur schreiben, wenn:
					// - genau 3 Darts geworfen wurden
					// - vorher weniger als 3 waren (Visit gerade abgeschlossen)
					if (currentCount === 3 && this.lastThrowsCount < 3) {
						const lastThrows = currentThrows.slice(-3);
						const visitSum = lastThrows.reduce((sum, dart) => sum + this.calcScore(dart), 0);

						// WICHTIG: Immer schreiben, auch wenn Wert gleich bleibt
						this.setState("visit.score", { val: visitSum, ack: true });
					}

					// Zustand speichern
					this.lastThrowsCount = currentCount;
				} catch (e) {
					this.log.warn(`Autodarts API Fehler: ${e.message} | Daten: ${data.substring(0, 200)}...`);
					// Bei JSON-Fehler: Board war erreichbar, aber Antwort kaputt
					this.setState("online", true, true);
				}
			});
		});

		req.on("error", () => {
			if (!this.offline) {
				this.log.warn("Autodarts not reachable");
				this.offline = true;
			}
			this.setState("online", false, true); // Server offline
		});

		req.on("timeout", () => {
			req.destroy();
			this.setState("online", false, true); // Server offline bei Timeout
		});

		req.end();
	}

	/**
	 * Boardmanager Version abfragen
	 */
	fetchVersion() {
		const options = {
			host: this.config.host,
			port: this.config.port,
			path: "/api/version",
			method: "GET",
			timeout: 1500,
		};

		const req = http.request(options, res => {
			let data = "";
			res.on("data", chunk => (data += chunk));
			res.on("end", () => {
				try {
					const version = data.trim();
					this.setState("system.boardVersion", { val: version, ack: true });
				} catch (e) {
					this.log.warn(`Fehler beim Lesen der Version: ${e.message}`);
				}
			});
		});

		req.on("error", () => {
			this.log.warn("Version-API nicht erreichbar");
			this.setState("system.boardVersion", { val: "", ack: true });
		});

		req.on("timeout", () => {
			req.destroy();
			this.setState("system.boardVersion", { val: "", ack: true });
		});

		req.end();
	}

	/**
	 * Board-Konfiguration abfragen (Kameras)
	 */
	fetchConfig() {
		const options = {
			host: this.config.host,
			port: this.config.port,
			path: "/api/config",
			method: "GET",
			timeout: 1500,
		};

		const req = http.request(options, res => {
			let data = "";
			res.on("data", chunk => (data += chunk));
			res.on("end", () => {
				try {
					const cfg = JSON.parse(data);

					const cam = cfg.cam || {};
					const camInfo = {
						width: cam.width ?? 1280,
						height: cam.height ?? 720,
						fps: cam.fps ?? 20,
					};

					const json = JSON.stringify(camInfo);

					this.setState("system.cam0", { val: json, ack: true });
					this.setState("system.cam1", { val: json, ack: true });
					this.setState("system.cam2", { val: json, ack: true });
				} catch (e) {
					this.log.warn(`Fehler beim Lesen der Config: ${e.message} | Daten: ${data.substring(0, 200)}...`);
				}
			});
		});

		req.on("error", () => {
			this.log.warn("Config-API nicht erreichbar");
		});

		req.on("timeout", () => {
			req.destroy();
			this.log.warn("Config-API Timeout");
		});

		req.end();
	}

	onUnload(callback) {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
			}
			if (this.versionTimer) {
				clearInterval(this.versionTimer);
			}
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new Autodarts(options);
} else {
	new Autodarts();
}
