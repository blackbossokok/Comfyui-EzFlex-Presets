import {
	Vector4
} from '../libs/three.module.js';

// Minimal port of three.js examples/jsm/curves/NURBSUtils.js — provides the two
// functions NURBSCurve.js needs (calcBSplinePoint, calcNURBSDerivatives) plus their
// internal helpers. Used by FBXLoader for spline interpolation.

function findSpan( p, u, U ) {

	const n = U.length - p - 1;
	if ( u >= U[ n ] ) return n - 1;
	if ( u <= U[ p ] ) return p;
	let low = p;
	let high = n + 1;
	let mid = Math.floor( ( low + high ) / 2 );
	while ( u < U[ mid ] || u >= U[ mid + 1 ] ) {
		if ( u < U[ mid ] ) high = mid;
		else low = mid;
		mid = Math.floor( ( low + high ) / 2 );
	}
	return mid;

}

function calcBasisFun( p, u, U ) {

	const N = [];
	const left = [];
	const right = [];
	N[ 0 ] = 1.0;
	for ( let j = 1; j <= p; ++ j ) {
		left[ j ] = u - U[ p + 1 - j ];
		right[ j ] = U[ p + j ] - u;
		let saved = 0.0;
		for ( let r = 0; r < j; ++ r ) {
			const temp = N[ r ] / ( right[ r + 1 ] + left[ j - r ] );
			N[ r ] = saved + right[ r + 1 ] * temp;
			saved = left[ j - r ] * temp;
		}
		N[ j ] = saved;
	}
	return N;

}

function calcBSplinePoint( p, U, P, u ) {

	const span = findSpan( p, u, U );
	const N = calcBasisFun( p, u, U );
	const C = new Vector4( 0, 0, 0, 0 );
	for ( let j = 0; j < 4; ++ j ) {
		C.setComponent( j, 0.0 );
		for ( let i = 0; i <= p; ++ i ) {
			C.setComponent( j, C.getComponent( j ) + N[ i ] * P[ span - p + i ].getComponent( j ) );
		}
	}
	return C;

}

function calcDersBasisFun( span, u, p, n, U ) {

	const ders = [];
	const ndu = [];
	const left = [];
	const right = [];
	for ( let i = 0; i <= p; ++ i ) {
		ndu[ i ] = [];
		ndu[ i ][ 0 ] = 0.0;
	}
	ndu[ 0 ][ 0 ] = 1.0;
	for ( let j = 1; j <= p; ++ j ) {
		left[ j ] = u - U[ span + 1 - j ];
		right[ j ] = U[ span + j ] - u;
		let saved = 0.0;
		for ( let r = 0; r < j; ++ r ) {
			ndu[ j ][ r ] = right[ r + 1 ] + left[ j - r ];
			const temp = ndu[ r ][ j - 1 ] / ndu[ j ][ r ];
			ndu[ r ][ j ] = saved + right[ r + 1 ] * temp;
			saved = left[ j - r ] * temp;
		}
		ndu[ j ][ j ] = saved;
	}
	for ( let j = 0; j <= p; ++ j ) {
		ders[ j ] = [];
		for ( let k = 0; k <= n; ++ k ) ders[ j ][ k ] = 0.0;
	}
	for ( let j = 0; j <= p; ++ j ) ders[ j ][ 0 ] = ndu[ j ][ p ];
	for ( let r = 0; r <= p; ++ r ) {
		let s1 = 0;
		let s2 = 1;
		const a = [];
		for ( let i = 0; i <= p; ++ i ) {
			a[ i ] = [];
			for ( let j = 0; j <= p; ++ j ) a[ i ][ j ] = 0.0;
		}
		a[ 0 ][ 0 ] = 1.0;
		for ( let k = 1; k <= n; ++ k ) {
			let d = 0.0;
			const rk = r - k;
			const pk = p - k;
			if ( r >= k ) {
				a[ s2 ][ 0 ] = a[ s1 ][ 0 ] / ndu[ pk + 1 ][ rk ];
				d = a[ s2 ][ 0 ] * ndu[ rk ][ pk ];
			}
			const j1 = ( rk >= - 1 ) ? 1 : - rk;
			const j2 = ( r - 1 <= pk ) ? k - 1 : p - r;
			for ( let j = j1; j <= j2; ++ j ) {
				a[ s2 ][ j ] = ( a[ s1 ][ j ] - a[ s1 ][ j - 1 ] ) / ndu[ pk + 1 ][ rk + j ];
				d += a[ s2 ][ j ] * ndu[ rk + j ][ pk ];
			}
			if ( r <= pk ) {
				a[ s2 ][ k ] = - a[ s1 ][ k - 1 ] / ndu[ pk + 1 ][ r ];
				d += a[ s2 ][ k ] * ndu[ r ][ pk ];
			}
			ders[ k ][ r ] = d;
			const j = s1;
			s1 = s2;
			s2 = j;
		}
	}
	let r = p;
	for ( let k = 1; k <= n; ++ k ) {
		for ( let j = 0; j <= p; ++ j ) ders[ k ][ j ] *= r;
		r *= p - k;
	}
	return ders;

}

function calcNURBSDerivatives( p, U, P, u, nd ) {

	const span = findSpan( p, u, U );
	const nders = calcDersBasisFun( span, u, p, nd, U );
	const CK = [];
	const w = [];
	for ( let i = 0; i <= p; ++ i ) w[ i ] = P[ span - p + i ].w;
	for ( let k = 0; k <= nd; ++ k ) {
		const v = new Vector4( 0, 0, 0, 0 );
		for ( let j = 0; j <= p; ++ j ) {
			v.x += nders[ k ][ j ] * P[ span - p + j ].x;
			v.y += nders[ k ][ j ] * P[ span - p + j ].y;
			v.z += nders[ k ][ j ] * P[ span - p + j ].z;
			v.w += nders[ k ][ j ] * P[ span - p + j ].w;
		}
		CK[ k ] = v;
	}
	for ( let k = 0; k <= nd; ++ k ) {
		const v = CK[ k ].clone();
		for ( let i = 1; i <= k; ++ i ) v.sub( CK[ k - i ].clone().multiplyScalar( CK[ i ].w ) );
		v.divideScalar( CK[ 0 ].w );
		CK[ k ] = v;
	}
	return CK;

}

export { findSpan, calcBasisFun, calcBSplinePoint, calcDersBasisFun, calcNURBSDerivatives };
