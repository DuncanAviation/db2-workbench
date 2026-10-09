import { expect } from 'chai';
import { buildStyle, parseStyle } from './mxgraph-style.js';

describe('mxgraph-style', () => {
	describe('parseStyle', () => {
		it('returns an empty object for undefined/empty input', () => {
			expect(parseStyle(undefined)).to.deep.equal({});
			expect(parseStyle('')).to.deep.equal({});
		});

		it('parses key=value pairs', () => {
			expect(parseStyle('fillColor=none;strokeColor=#4C9AFF;')).to.deep.equal({fillColor: 'none', strokeColor: '#4C9AFF'});
		});

		it('parses a leading bare flag (no "=") alongside key=value pairs', () => {
			expect(parseStyle('group;fillColor=none;')).to.deep.equal({group: '', fillColor: 'none'});
		});

		it('handles a value that itself contains "=" (only splits on the first)', () => {
			expect(parseStyle('points=[[0,0.5],[1,0.5]];')).to.deep.equal({points: '[[0,0.5],[1,0.5]]'});
		});
	});

	describe('buildStyle', () => {
		it('builds a semicolon-delimited key=value string', () => {
			expect(buildStyle({fillColor: 'none', strokeColor: '#4C9AFF'})).to.equal('fillColor=none;strokeColor=#4C9AFF;');
		});

		it('round-trips a bare flag back to its bare form', () => {
			expect(buildStyle(parseStyle('group;fillColor=none;'))).to.equal('group;fillColor=none;');
		});
	});
});
