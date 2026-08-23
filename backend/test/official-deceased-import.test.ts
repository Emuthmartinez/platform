import { describe, expect, it } from "vitest";
import "./helpers";
import {
	previewOfficialDeceasedImport,
	tableToOfficialDeceasedRows,
} from "@/services/official-deceased";

describe("official deceased import", () => {
	it("maps Spanish headers and ignores empty rows", () => {
		const rows = tableToOfficialDeceasedRows([
			["Nombre", "Edad", "Municipio", "Observaciones"],
			["DEMO Persona Uno", "42", "Ciudad Demo", "Registro sintético"],
			["", "", "", ""],
		]);
		expect(rows).toEqual([
			{
				name: "DEMO Persona Uno",
				age: "42",
				location: "Ciudad Demo",
				description: "Registro sintético",
			},
		]);
	});

	it("requires an explicit name column", () => {
		expect(() =>
			tableToOfficialDeceasedRows([
				["Edad", "Lugar"],
				["50", "Ciudad Demo"],
			]),
		).toThrow("necesita una columna Nombre");
	});

	it("deduplicates normalized identities and reports invalid rows", () => {
		const preview = previewOfficialDeceasedImport([
			{ name: "DEMO José Pérez", age: "30", location: "Zona Norte" },
			{ name: "demo jose perez", age: 30, location: "zona norte" },
			{ name: "DEMO Persona Dos", age: "999" },
			{ name: "" },
		]);
		expect(preview).toMatchObject({
			totalRows: 4,
			validRows: 1,
			invalidRows: 2,
			duplicateRows: 1,
		});
		expect(preview.errors).toEqual([
			{ row: 4, message: "La edad debe estar entre 0 y 130." },
			{ row: 5, message: "Falta el nombre." },
		]);
	});
});
