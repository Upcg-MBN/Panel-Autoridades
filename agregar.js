// Agregación del cubo, con la semántica de las medidas del Power BI
// (reporte_autoridades_v2). Vive aparte de index.html para que prueba.js la
// corra con node: es la lógica que se equivoca en silencio.
//
//   Ingresados   FLUJO  expedientes que iniciaron en el periodo  -> se suman
//   Finalizados  FLUJO  expedientes que terminaron en el periodo -> se suman
//   Mochila      SALDO  abiertos al último día del periodo       -> NO se suma
//
// La mochila no viene en el cubo: es la suma acumulada de ingresos menos bajas
// desde el primer mes de la base hasta el corte. El filtro de año solo mueve el
// corte; región, grupo y trámite sí recortan. Es REMOVEFILTERS(Fecha) en DAX:
// si se elige 2026, la mochila sigue contando lo que ingresó en 2019 y sigue
// abierto.

(function (global) {
  'use strict';

  var PASO = 6;   // [mes, región, trámite, ingresados, finalizados, bajas]

  // Meses visibles como índices de D.meses. El primero de D.meses es el mes
  // base (lo anterior a 1999): pesa en la mochila pero no se muestra.
  function periodo(D, anio) {
    var ultimo = D.meses.length - 1;
    if (!anio) return { desde: 1, hasta: ultimo, grano: 'anual' };
    var desde = D.meses.indexOf(anio + '-01');
    if (desde < 0) return null;
    var hasta = D.meses.indexOf(anio + '-12');
    return { desde: desde, hasta: hasta < 0 ? ultimo : hasta, grano: 'mensual' };
  }

  function indice(lista, clave, valor) {
    if (valor == null) return -1;
    for (var i = 0; i < lista.length; i++) if (lista[i][clave] === valor) return i;
    return -2;   // valor que no existe: no pasa nada, en vez de pasar todo
  }

  // f = { anio: '2026'|null, grupo: string|null, tramites: [string]|null, region: '13'|null }
  // `tramites` admite varios: null (o vacío) = todos.
  function calcular(D, f) {
    var p = periodo(D, f.anio);
    if (!p) return null;
    var c = D.cubo, nM = D.meses.length;
    var nR = D.regiones.length, nT = D.tramites.length;
    var fr = indice(D.regiones, 'codigo', f.region);
    var ft = null;   // {índice: true} de los trámites elegidos
    if (f.tramites && f.tramites.length) {
      ft = {};
      f.tramites.forEach(function (n) { var j = indice(D.tramites, 'nombre', n); if (j >= 0) ft[j] = true; });
    }
    var grupoDe = D.tramites.map(function (t) { return t.grupo; });

    var ing = new Float64Array(nM), fin = new Float64Array(nM), neto = new Float64Array(nM);
    // El mapa y el ranking se calculan SIN su propio filtro, para poder mostrar
    // todas las regiones y resaltar la elegida: el resaltado cruzado del Power
    // BI. Lo mismo el desglose por trámite.
    var reg = { ing: new Float64Array(nR), fin: new Float64Array(nR), moc: new Float64Array(nR) };
    var tra = { ing: new Float64Array(nT), fin: new Float64Array(nT), moc: new Float64Array(nT) };

    for (var i = 0; i < c.length; i += PASO) {
      var m = c[i], r = c[i + 1], t = c[i + 2];
      if (f.grupo && grupoDe[t] !== f.grupo) continue;
      if (m > p.hasta) continue;                    // después del corte no pesa en nada
      var okR = fr === -1 || r === fr, okT = !ft || ft[t] === true;
      var dentro = m >= p.desde, n = c[i + 3] - c[i + 5];
      if (okR && okT) { ing[m] += c[i + 3]; fin[m] += c[i + 4]; neto[m] += n; }
      if (okT) {
        reg.moc[r] += n;
        if (dentro) { reg.ing[r] += c[i + 3]; reg.fin[r] += c[i + 4]; }
      }
      if (okR) {
        tra.moc[t] += n;
        if (dentro) { tra.ing[t] += c[i + 3]; tra.fin[t] += c[i + 4]; }
      }
    }

    var moc = new Float64Array(nM), acc = 0;
    for (var k = 0; k < nM; k++) { acc += neto[k]; moc[k] = acc; }

    // Serie: por mes dentro de un año, o por año sin filtro de año. En la
    // anual la mochila es la del último mes de cada año, nunca la suma.
    var serie = [];
    if (p.grano === 'mensual') {
      for (k = p.desde; k <= p.hasta; k++) {
        serie.push({ etiqueta: D.meses[k], desde: k, hasta: k, ing: ing[k], fin: fin[k],
                     moc: moc[k], parcial: D.meses[k] === D.mes_parcial });
      }
    } else {
      for (k = p.desde; k <= p.hasta; k++) {
        var anio = D.meses[k].slice(0, 4), s = serie[serie.length - 1];
        if (!s || s.etiqueta !== anio) {
          s = { etiqueta: anio, desde: k, hasta: k, ing: 0, fin: 0, moc: 0, parcial: false };
          serie.push(s);
        }
        s.hasta = k; s.ing += ing[k]; s.fin += fin[k]; s.moc = moc[k];
        if (D.meses[k] === D.mes_parcial) s.parcial = true;
      }
    }

    var tIng = 0, tFin = 0;
    for (k = p.desde; k <= p.hasta; k++) { tIng += ing[k]; tFin += fin[k]; }

    return {
      periodo: p,
      corte: D.meses[p.hasta],
      serie: serie,
      kpi: {
        ing: tIng, fin: tFin, saldo: tIng - tFin,
        moc: moc[p.hasta],
        // Mochila al cierre del periodo anterior. Sin año elegido no hay
        // periodo anterior que valga: sería la mochila de diciembre de 1998.
        mocAnterior: p.grano === 'mensual' ? moc[p.desde - 1] : null
      },
      porRegion: D.regiones.map(function (x, j) {
        return { codigo: x.codigo, nombre: x.nombre, ing: reg.ing[j], fin: reg.fin[j], moc: reg.moc[j] };
      }),
      porTramite: D.tramites.map(function (x, j) {
        return { nombre: x.nombre, grupo: x.grupo, ing: tra.ing[j], fin: tra.fin[j], moc: tra.moc[j] };
      })
    };
  }

  // Cortes naturales (Fisher-Jenks) para las clases del mapa. Los quintiles
  // reparten las regiones en grupos del mismo tamaño, así que la Metropolitana
  // (44.510) caía en la misma clase que La Araucanía (14.472). Los cortes
  // naturales minimizan la varianza dentro de cada clase: los saltos grandes
  // separan clases y la RM queda sola arriba. Con 16 valores el cálculo exacto
  // por programación dinámica es instantáneo.
  //
  // Devuelve los límites superiores de cada clase salvo la última, redondeados
  // a la cifra más corta que no cambia la clase de ninguna región.
  function cortes(valores, k) {
    var v = valores.filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    var n = v.length;
    k = Math.min(k, n);
    if (k < 2) return [];
    var s = [0], s2 = [0];
    for (var i = 0; i < n; i++) { s.push(s[i] + v[i]); s2.push(s2[i] + v[i] * v[i]); }
    var dispersion = function (a, b) {       // suma de cuadrados de v[a..b]
      var t = s[b + 1] - s[a];
      return s2[b + 1] - s2[a] - t * t / (b - a + 1);
    };
    var costo = [[]], inicio = [[]];
    for (var j = 0; j < n; j++) { costo[0][j] = dispersion(0, j); inicio[0][j] = 0; }
    for (var c = 1; c < k; c++) {
      costo[c] = []; inicio[c] = [];
      for (j = c; j < n; j++) {
        costo[c][j] = Infinity;
        for (i = c; i <= j; i++) {
          var x = costo[c - 1][i - 1] + dispersion(i, j);
          if (x < costo[c][j]) { costo[c][j] = x; inicio[c][j] = i; }
        }
      }
    }
    var comienzos = [];
    for (c = k - 1, j = n - 1; c > 0; c--) { comienzos.unshift(inicio[c][j]); j = inicio[c][j] - 1; }
    return comienzos.map(function (a) { return redondo(v[a - 1], v[a]); });
  }
  // La cifra con menos dígitos significativos en [a, b): 697 y 755 dan 700.
  function redondo(a, b) {
    for (var d = 1; d < 10; d++) {
      var e = Math.pow(10, Math.floor(Math.log(b) / Math.LN10) - d + 1);
      var x = Math.ceil(a / e) * e;
      if (x < b) return x;
    }
    return a;
  }

  var api = { periodo: periodo, calcular: calcular, cortes: cortes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AGG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
