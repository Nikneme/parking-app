'use strict';

function buildReferenceDevices() {
  return [
    { id: 'sh1', name: 'Ш1', zone_id: 'buffer', type: 'http', method: 'POST', url: 'http://example.local/open/sh1', sort: 10, enabled: true },
    { id: 'sh2', name: 'Ш2', zone_id: 'buffer', type: 'http', method: 'POST', url: 'http://example.local/open/sh2', sort: 20, enabled: true },
    { id: 'sh34', name: 'Ш3/4', zone_id: 'buffer', type: 'http', method: 'POST', url: 'http://example.local/open/sh34', sort: 30, enabled: true },
    { id: 'v1', name: 'Въезд В1', zone_id: 'overground', type: 'http', method: 'POST', url: 'http://example.local/open/v1', sort: 40, enabled: true },
    { id: 'lift1', name: 'Лифт 1', zone_id: 'pedestrian', type: 'http', method: 'POST', url: 'http://example.local/open/lift1', sort: 50, enabled: true },
    { id: 'lift2', name: 'Лифт 2', zone_id: 'pedestrian', type: 'http', method: 'POST', url: 'http://example.local/open/lift2', sort: 60, enabled: true },
    { id: 'door1', name: 'Дверь 1', zone_id: 'pedestrian', type: 'http', method: 'POST', url: 'http://example.local/open/door1', sort: 70, enabled: true },
    { id: 'door2', name: 'Дверь 2', zone_id: 'pedestrian', type: 'http', method: 'POST', url: 'http://example.local/open/door2', sort: 80, enabled: true },
    { id: 'e7_in', name: 'Въезд 7эт', zone_id: 'europlan', type: 'http', method: 'POST', url: 'http://example.local/open/e7-in', sort: 90, enabled: true },
    { id: 'e7_out', name: 'Выезд 7эт', zone_id: 'europlan', type: 'http', method: 'POST', url: 'http://example.local/open/e7-out', sort: 100, enabled: true },
    { id: 'e8_in', name: 'Въезд 8эт', zone_id: 'europlan', type: 'http', method: 'POST', url: 'http://example.local/open/e8-in', sort: 110, enabled: true },
    { id: 'e8_out', name: 'Выезд 8эт', zone_id: 'europlan', type: 'http', method: 'POST', url: 'http://example.local/open/e8-out', sort: 120, enabled: true },
    { id: 'e9_in', name: 'Въезд 9эт', zone_id: 'europlan', type: 'http', method: 'POST', url: 'http://example.local/open/e9-in', sort: 130, enabled: true },
    { id: 'e9_out', name: 'Выезд 9эт', zone_id: 'europlan', type: 'http', method: 'POST', url: 'http://example.local/open/e9-out', sort: 140, enabled: true },
    { id: 'p1', name: 'Въезд П1', zone_id: 'underground', type: 'http', method: 'POST', url: 'http://example.local/open/p1', sort: 150, enabled: true },
    { id: 'p2', name: 'Въезд П2/3', zone_id: 'underground', type: 'http', method: 'POST', url: 'http://example.local/open/p2', sort: 160, enabled: true },
    { id: 'sh6', name: 'Ш 6', zone_id: 'transit', type: 'http', method: 'POST', url: 'http://example.local/open/sh6', sort: 170, enabled: true },
    { id: 'sh7', name: 'Ш 7', zone_id: 'transit', type: 'http', method: 'POST', url: 'http://example.local/open/sh7', sort: 180, enabled: true },
  ];
}

module.exports = {
  buildReferenceDevices,
};
