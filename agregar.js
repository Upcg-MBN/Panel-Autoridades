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
    var reg = { ing: new Float64Array(nR), fin: new Float64Array(nR), moc: new Float64Array(nR),
                base: new Float64Array(nR), porTram: new Float64Array(nR * nT) };
    var tra = { ing: new Float64Array(nT), fin: new Float64Array(nT), moc: new Float64Array(nT) };
    // Corte contra el que se mide la variación del stock por región: el mismo
    // mes del año anterior, como toda comparación del panel.
    var base = Math.max(0, p.hasta - 12);

    for (var i = 0; i < c.length; i += PASO) {
      var m = c[i], r = c[i + 1], t = c[i + 2];
      if (f.grupo && grupoDe[t] !== f.grupo) continue;
      if (m > p.hasta) continue;                    // después del corte no pesa en nada
      var okR = fr === -1 || r === fr, okT = !ft || ft[t] === true;
      var dentro = m >= p.desde, n = c[i + 3] - c[i + 5];
      if (okR && okT) { ing[m] += c[i + 3]; fin[m] += c[i + 4]; neto[m] += n; }
      if (okT) {
        reg.moc[r] += n;
        reg.porTram[r * nT + t] += n;
        if (m <= base) reg.base[r] += n;
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
      corteBase: D.meses[base],
      porRegion: D.regiones.map(function (x, j) {
        return { codigo: x.codigo, nombre: x.nombre, ing: reg.ing[j], fin: reg.fin[j], moc: reg.moc[j],
                 mocBase: reg.base[j], mocPorTramite: Array.prototype.slice.call(reg.porTram, j * nT, (j + 1) * nT) };
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

  // ¿La celda (región r, trámite t) entra en el filtro? Para la foto, que no
  // tiene mapa ni desglose que mostrar sin filtro.
  function pasa(D, f) {
    var fr = indice(D.regiones, 'codigo', f.region), ft = null;
    if (f.tramites && f.tramites.length) {
      ft = {};
      f.tramites.forEach(function (n) { var j = indice(D.tramites, 'nombre', n); if (j >= 0) ft[j] = true; });
    }
    return function (r, t) {
      return (fr === -1 || r === fr) && (!ft || ft[t] === true) && (!f.grupo || D.tramites[t].grupo === f.grupo);
    };
  }

  // Comparación con el año anterior, «a la misma altura»: los meses cerrados
  // del año (el elegido, o el en curso sin filtro de año) contra los mismos
  // meses del año anterior. El mes en curso no entra: comparar 21 días contra
  // un mes completo se lee como una caída que no ocurrió. El stock, que es un
  // saldo, se compara en el corte contra el mismo mes del año anterior.
  // Devuelve null si el año aún no tiene meses cerrados (enero en curso) o si
  // el año anterior no está en la base.
  function comparacion(D, f) {
    var anio = f.anio || D.mes_parcial.slice(0, 4), ant = String(+anio - 1);
    var cerrados = anio === D.mes_parcial.slice(0, 4) ? +D.mes_parcial.slice(5, 7) - 1 : 12;
    var i0 = D.meses.indexOf(anio + '-01'), a0 = D.meses.indexOf(ant + '-01');
    if (cerrados < 1 || i0 < 0 || a0 < 0) return null;
    var p = periodo(D, f.anio), corte = p.hasta, ok = pasa(D, f), c = D.cubo;
    var nR = D.regiones.length, cero = function (n) { var a = []; while (n--) a.push(0); return a; };
    var act = { ing: cero(12), fin: cero(12) }, prev = { ing: cero(12), fin: cero(12) };
    var reg = D.regiones.map(function () { return { ing: 0, fin: 0, ingAnt: 0, finAnt: 0 }; });
    var moc = 0, mocAnt = 0;
    var okRT = pasa(D, { grupo: f.grupo, tramites: f.tramites });   // sin región: la dispersión muestra todas
    for (var i = 0; i < c.length; i += PASO) {
      var m = c[i], r = c[i + 1], t = c[i + 2], enR = ok(r, t);
      if (enR) {
        if (m <= corte) moc += c[i + 3] - c[i + 5];
        if (m <= corte - 12) mocAnt += c[i + 3] - c[i + 5];
      }
      var k = m - i0, ka = m - a0;
      if (k >= 0 && k < 12) {
        if (enR) { act.ing[k] += c[i + 3]; act.fin[k] += c[i + 4]; }
        if (k < cerrados && okRT(r, t)) { reg[r].ing += c[i + 3]; reg[r].fin += c[i + 4]; }
      } else if (ka >= 0 && ka < 12) {
        if (enR) { prev.ing[ka] += c[i + 3]; prev.fin[ka] += c[i + 4]; }
        if (ka < cerrados && okRT(r, t)) { reg[r].ingAnt += c[i + 3]; reg[r].finAnt += c[i + 4]; }
      }
    }
    var suma = function (xs) { var s = 0; for (var j = 0; j < cerrados; j++) s += xs[j]; return s; };
    return {
      anio: anio, anterior: ant, cerrados: cerrados,
      act: { ing: suma(act.ing), fin: suma(act.fin), moc: moc },
      ant: { ing: suma(prev.ing), fin: suma(prev.fin), moc: mocAnt },
      mesesAnt: prev,                 // los doce meses del año anterior, para las marcas del gráfico
      corteAnt: D.meses[Math.max(0, corte - 12)],
      porRegion: D.regiones.map(function (x, j) { return { codigo: x.codigo, nombre: x.nombre, ing: reg[j].ing, fin: reg[j].fin,
                                                           ingAnt: reg[j].ingAnt, finAnt: reg[j].finAnt }; })
    };
  }

  // Métricas de la actividad actual, en el orden de D.foto.act: expedientes,
  // con actividad abierta, con plazo, fuera de plazo, más de 2 veces el plazo,
  // días en la actividad, y días y plazo de los que tienen plazo.
  var MET = ['n', 'conAct', 'con', 'fuera', 'fuera2', 'dias', 'diasCon', 'plazoCon'];
  function ceros(o) { MET.forEach(function (m) { o[m] = 0; }); return o; }
  function sumar(a, b) { MET.forEach(function (m) { a[m] += b[m]; }); }

  // Foto del stock a la fecha de extracción (página Gestión). No mira el año:
  // es la foto de hoy. Región, grupo y trámite sí la recortan.
  function foto(D, f) {
    var F = D.foto;
    if (!F) return null;
    var ok = pasa(D, f), nQ = F.quieto.length, c, i, x;
    var eq = F.edad.map(function () { return F.quieto.map(function () { return 0; }); });
    for (c = F.eq, i = 0; i < c.length; i += 4) {
      if (ok(c[i], c[i + 1])) eq[Math.floor(c[i + 2] / nQ)][c[i + 2] % nQ] += c[i + 3];
    }
    var rol = F.roles.map(function (n) { return { nombre: n, n: 0, con: 0, fuera: 0 }; });
    for (c = F.rol, i = 0; i < c.length; i += 6) {
      if (!ok(c[i], c[i + 1])) continue;
      x = rol[c[i + 2]]; x.n += c[i + 3]; x.con += c[i + 4]; x.fuera += c[i + 5];
    }
    // Actividad actual, sumada por trámite × nodo del catálogo.
    var act = {}, lista = [];
    for (c = F.act, i = 0; i < c.length; i += 3 + MET.length) {
      if (!ok(c[i], c[i + 1])) continue;
      var k = c[i + 1] + '|' + c[i + 2];
      if (!act[k]) { act[k] = ceros({ t: c[i + 1], nodo: F.nodos[c[i + 2]] }); lista.push(act[k]); }
      for (var j = 0; j < MET.length; j++) act[k][MET[j]] += c[i + 3 + j];
    }
    var detalle = F.detalle.filter(function (d) { return ok(d[1], d[2]); }).map(function (d) {
      return { nro: d[0], region: D.regiones[d[1]].nombre, tramite: D.tramites[d[2]].nombre, inicio: d[3],
               quieto: d[4], nodo: F.nodos[d[5]], rol: F.roles[d[6]], dias: d[7], plazo: d[8] };
    });
    return { fecha: F.fecha, edad: F.edad, quieto: F.quieto, eq: eq, rol: rol, act: lista, detalle: detalle };
  }

  // Árbol de la matriz: [trámite →] etapa → subetapa → actividad, con las
  // métricas sumadas en cada nivel. Un nivel vacío (el expediente sin
  // actividad abierta, la actividad sin etapa en el catálogo) se salta. Cada
  // nivel, de mayor a menor stock.
  function arbol(D, act, conTramite) {
    var raiz = { hijos: [] };
    act.forEach(function (a) {
      var nodo = raiz;
      (conTramite ? [D.tramites[a.t].nombre] : []).concat(a.nodo).filter(Boolean).forEach(function (nombre) {
        var h = nodo.hijos.filter(function (y) { return y.nombre === nombre; })[0];
        if (!h) { h = ceros({ nombre: nombre, hijos: [] }); nodo.hijos.push(h); }
        sumar(h, a);
        nodo = h;
      });
    });
    (function ordenar(n) {
      n.hijos.sort(function (p, q) { return q.n - p.n; });
      n.hijos.forEach(ordenar);
    })(raiz);
    return raiz.hijos;
  }

  // Semáforo de plazo por trámite: dentro, hasta 2 veces, más de 2 veces y
  // sin plazo en el catálogo (incluye los sin actividad abierta).
  function semaforo(D, act) {
    var por = {};
    act.forEach(function (a) {
      if (!por[a.t]) por[a.t] = ceros({ nombre: D.tramites[a.t].nombre });
      sumar(por[a.t], a);
    });
    return Object.keys(por).map(function (t) {
      var x = por[t];
      return { nombre: x.nombre, n: x.n, dentro: x.con - x.fuera, hasta2: x.fuera - x.fuera2,
               mas2: x.fuera2, sin: x.n - x.con };
    }).sort(function (p, q) { return q.n - p.n; });
  }

  var api = { periodo: periodo, calcular: calcular, cortes: cortes, comparacion: comparacion,
              foto: foto, arbol: arbol, semaforo: semaforo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AGG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
