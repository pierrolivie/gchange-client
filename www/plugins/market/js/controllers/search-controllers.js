angular.module('cesium.market.search.controllers', ['cesium.market.record.services', 'cesium.es.services', 'cesium.es.common.controllers'])

  .config(function($stateProvider) {
    'ngInject';

    $stateProvider

    .state('app.market_lookup', {
      url: "/market?q&category&location&reload&type&hash&lat&lon",
      views: {
        'menuContent': {
          templateUrl: "plugins/market/templates/search/lookup.html",
          controller: 'MkLookupCtrl'
        }
      },
      data: {
        large: 'app.market_lookup_lg',
        silentLocationChange: true
      }
    })

    .state('app.market_lookup_lg', {
      url: "/market/lg?q&category&location&reload&type&hash&closed&lat&lon",
      views: {
        'menuContent': {
          templateUrl: "plugins/market/templates/search/lookup_lg.html",
          controller: 'MkLookupCtrl'
        }
      },
      data: {
        silentLocationChange: true
      }
    })

    .state('app.market_gallery', {
      cache: true,
      url: "/gallery/market",
      views: {
        'menuContent': {
          templateUrl: "plugins/market/templates/gallery/view_gallery.html",
          controller: 'MkViewGalleryCtrl'
        }
      }
    });
  })

 .controller('MkLookupAbstractCtrl', MkLookupAbstractController)

 .controller('MkLookupCtrl', MkLookupController)

 .controller('MkViewGalleryCtrl', MkViewGalleryController)

;

function MkLookupAbstractController($scope, $state, $filter, $q, $location, $translate, $controller, UIUtils, esHttp,
                                    ModalUtils, csConfig, csSettings, mkRecord, BMA, mkSettings, esProfile) {
  'ngInject';

  // Initialize the super class and extend it.
  angular.extend(this, $controller('ESLookupPositionCtrl', {$scope: $scope}));

  var defaultSearchLimit = 10;

  $scope.search = {
    text: '',
    type: null,
    lastRecords: true,
    results: [],
    loading: true,
    category: null,
    location: null,
    geoPoint: null,
    options: null,
    loadingMore: false,
    showClosed: false,
    geoDistance: !isNaN(csSettings.data.plugins.es.geoDistance) ? csSettings.data.plugins.es.geoDistance : 20
  };

  // Screen options
  $scope.options = $scope.options || angular.merge({
      type: {
        show: true
      },
      category: {
        show: true
      },
      description: {
        show: true
      },
      location: {
        show: true,
        prefix : undefined
      },
      fees: {
        show: true
      }
    }, csConfig.plugins && csConfig.plugins.market && csConfig.plugins.market.record || {});

  $scope.$watch('search.showClosed', function() {
    $scope.options.showClosed = $scope.search.showClosed;
  }, true);

  $scope.init = function() {
    return $q.all([
        // Init currency
        mkSettings.currencies()
          .then(function(currencies) {
            $scope.currencies = currencies;
        }),
        // Resolve distance unit
        $translate('LOCATION.DISTANCE_UNIT')
          .then(function(unit) {
            $scope.geoUnit = unit;
          })
       ]);
  };

  $scope.toggleAdType = function(type) {
    if (type === $scope.search.type) {
      $scope.search.type = undefined;
    }
    else {
      $scope.search.type = type;
    }
    if ($scope.search.lastRecords) {
      $scope.doGetLastRecord();
    }
    else {
      $scope.doSearch();
    }
  };

  $scope.doSearch = function(from) {
    $scope.search.loading = !from;
    $scope.search.lastRecords = false;
    if (!$scope.search.advanced) {
      $scope.search.advanced = false;
    }

    if ($scope.search.location && !$scope.search.geoPoint) {
      return $scope.searchPosition($scope.search.location)
        .then(function(res) {
          if (!res) {
            $scope.search.loading = false;
            return UIUtils.alert.error('MARKET.ERROR.GEO_LOCATION_NOT_FOUND');
          }
          //console.debug('[market] search by location results:', res);
          $scope.search.geoPoint = res;
          $scope.search.location = res.name && res.name.split(',')[0] || $scope.search.location;
          return $scope.doSearch(from);
        });
    }

    var text = $scope.search.text.trim();
    var matches = [];
    var filters = [];
    var tags = text ? esHttp.util.parseTags(text) : undefined;
    if (text.length > 1) {
      // pubkey : use a special 'term', because of 'non indexed' field
      if (BMA.regexp.PUBKEY.test(text /*case sensitive*/)) {
        matches = [];
        filters.push({term : { issuer: text}});
      }
      else {
        text = text.toLowerCase();
        var matchFields = ["title", "description"];
        matches.push({multi_match : { query: text,
          fields: matchFields,
          type: "phrase_prefix"
        }});
        matches.push({match: {title: {query: text, boost: 2}}});
        matches.push({prefix: {title: text}});
        matches.push({match: {description: text}});
        matches.push({
           nested: {
             path: "category",
             query: {
               bool: {
                 filter: {
                   match: { "category.name": text}
                 }
               }
             }
           }
         });
      }
    }

    if ($scope.search.category) {
      filters.push({
        nested: {
          path: "category",
          query: {
            bool: {
              filter: {
                term: { "category.id": $scope.search.category.id}
              }
            }
          }
        }
      });
    }


    if (tags) {
      filters.push({terms: {tags: tags}});
    }

    if (!matches.length && !filters.length) {
      return $scope.doGetLastRecord();
    }

    if ($scope.search.geoPoint && $scope.search.geoPoint.lat && $scope.search.geoPoint.lon) {

      filters.push({
        geo_distance: {
          distance: $scope.search.geoDistance + $scope.geoUnit,
          geoPoint: {
            lat: $scope.search.geoPoint.lat,
            lon: $scope.search.geoPoint.lon
          }
        }});
    }

    var stateParams = {};

    if ($scope.search.showClosed) {
      stateParams.closed = true;
    }
    else {
      filters.push({range: {stock: {gt: 0}}});
    }

    if ($scope.search.type) {
      filters.push({term: {type: $scope.search.type}});
      stateParams.type = $scope.search.type;
    }

    // filter on currency
    if ($scope.currencies) {
      filters.push({terms: {currency: $scope.currencies}});
    }
    stateParams.q = $scope.search.text;

    var query = {bool: {}};
    if (matches.length > 0) {
      query.bool.should = matches;
      // Exclude result with score=0 (e.g. same city, but does not match any text search)
      query.bool.minimum_should_match = 1;
    }
    if (filters.length > 0) {
      query.bool.filter = filters;
    }

    // Update location href
    if (!from) {
      $location.search(stateParams).replace();
    }

    return $scope.doRequest({query: query, from: from});
  };

  $scope.doGetLastRecord = function(from) {

    $scope.search.lastRecords = true;

    var options = {
      sort: {
        "creationTime" : "desc"
      },
      from: from
    };

    var filters = [];
    var matches = [];
    if (!$scope.search.showClosed) {
      filters.push({range: {stock: {gt: 0}}});
    }
    // filter on type
    if ($scope.search.type) {
      filters.push({term: {type: $scope.search.type}});
    }
    // filter on currencies
    if ($scope.currencies) {
      filters.push({terms: {currency: $scope.currencies}});
    }

    var location = $scope.search.location && $scope.search.location.trim().toLowerCase();
    if ($scope.search.geoPoint && $scope.search.geoPoint.lat && $scope.search.geoPoint.lon) {

      // text match
      if (location && location.length) {
        matches.push({match_phrase: { city: location}});
      }

      filters.push({
        geo_distance: {
          distance: $scope.search.geoDistance + $scope.geoUnit,
          geoPoint: {
            lat: $scope.search.geoPoint.lat,
            lon: $scope.search.geoPoint.lon
          }
        }});
    }
    if (matches.length) {
      options.query = {bool: {}};
      options.query.bool.should =  matches;
    }
    if (filters.length) {
      options.query = options.query || {bool: {}};
      options.query.bool.filter =  filters;
    }

    return $scope.doRequest(options);
  };

  $scope.doRefresh = function() {
    var searchFunction = ($scope.search.lastRecords) ?
        $scope.doGetLastRecord :
        $scope.doSearch;
    return searchFunction();
  };

  $scope.showMore = function() {
    var from = $scope.search.results ? $scope.search.results.length : 0;

    $scope.search.loadingMore = true;

    var searchFunction = ($scope.search.lastRecords) ?
      $scope.doGetLastRecord :
      $scope.doSearch;

    return searchFunction(from)
      .then(function() {
        $scope.search.loadingMore = false;
        $scope.$broadcast('scroll.infiniteScrollComplete');
      })
      .catch(function(err) {
        console.error(err);
        $scope.search.loadingMore = false;
        $scope.search.hasMore = false;
        $scope.$broadcast('scroll.infiniteScrollComplete');
      });
  };

  $scope.doRequest = function(options) {
    options = options || {};
    options.from = options.from || 0;
    options.size = options.size || defaultSearchLimit;
    if (options.size < defaultSearchLimit) options.size = defaultSearchLimit;
    $scope.search.loading = (options.from === 0);

    return  mkRecord.record.search(options)
    .then(function(records) {
      if (!records && !records.length) {
        $scope.search.results = (options.from > 0) ? $scope.search.results : [];
        $scope.search.total = (options.from > 0) ? $scope.search.total : 0;
        $scope.search.hasMore = false;
        $scope.search.loading = false;
        return;
      }

      // Filter on type (workaround if filter on term 'type' not working)
      var formatSlug = $filter('formatSlug');
      records.reduce(function (res, record) {
        if ($scope.search.type && $scope.search.type != record.type) {
          return res;
        }
        record.urlTitle = formatSlug(record.title);
        return res.concat(record);
      }, []);

      return esProfile.fillAvatars(records, 'issuer');
    })
    .then(function(records) {

      // Replace results, or append if 'show more' clicked
      if (!options.from) {
        $scope.search.results = records;
      }
      else {
        $scope.search.results = $scope.search.results.concat(records);
      }
      $scope.search.hasMore = $scope.search.results.length >= options.from + options.size;
      $scope.search.loading = false;

      // motion
      if (records.length > 0) {
        $scope.motion.show();
      }
    })
    .catch(function(err) {
      $scope.search.loading = false;
      $scope.search.results = (options.from > 0) ? $scope.search.results : [];
      $scope.search.hasMore = false;
      UIUtils.onError('MARKET.ERROR.LOOKUP_RECORDS_FAILED')(err);
    });
  };

  /* -- modals -- */

  $scope.showCategoryModal = function() {
    // load categories
    return mkRecord.category.all()
      .then(function(categories){
        return ModalUtils.show('plugins/es/templates/common/modal_category.html', 'ESCategoryModalCtrl as ctrl',
          {categories : categories},
          {focusFirstInput: true}
        );
      })
      .then(function(cat){
        if (cat && cat.parent) {
          $scope.search.category = cat;
          $scope.doSearch();
        }
      });
  };

  $scope.showNewRecordModal = function() {
    return $scope.loadWallet({minData: true})
      .then(function() {
        return UIUtils.loading.hide();
      }).then(function() {
        if (!$scope.options.type.show && $scope.options.type.default) {
          return $scope.options.type.default;
        }
        return ModalUtils.show('plugins/market/templates/record/modal_record_type.html');
      })
      .then(function(type){
        if (type) {
          $state.go('app.market_add_record', {type: type});
        }
      });
  };

  $scope.showRecord = function(event, index) {
    if (event.defaultPrevented) return;
    var item = $scope.search.results[index];
    if (item) {
      $state.go('app.market_view_record', {
        id: item.id,
        title: item.title
      });
    }
  };

}


function MkLookupController($scope, $rootScope, $controller, $focus, $timeout, mkRecord, csSettings) {
  'ngInject';

  // Initialize the super class and extend it.
  angular.extend(this, $controller('MkLookupAbstractCtrl', {$scope: $scope}));


  $scope.enter = function(e, state) {
    if (!$scope.entered || !$scope.search.results || $scope.search.results.length === 0) {
      var showAdvanced = false;

      if (state.stateParams) {
        // Search by text
        if (state.stateParams.q) { // Query parameter
          $scope.search.text = state.stateParams.q;
        }

        // Search on type
        if (state.stateParams.type) {
          $scope.search.type = state.stateParams.type;
        }

        // Search on location
        if (state.stateParams.location) {
          $scope.search.location = state.stateParams.location;
        }

        // Geo point
        if (state.stateParams.lat && state.stateParams.lon) {
          $scope.search.geoPoint = {
            lat: parseFloat(state.stateParams.lat),
            lon: parseFloat(state.stateParams.lon)
          };
        }
        else if (state.stateParams.location) {
          // Try to get geoPoint from root scope
          $scope.search.geoPoint = $rootScope.geoPoints && $rootScope.geoPoints[state.stateParams.location] || null;
        }
        else {
          var defaultSearch = csSettings.data.plugins.es.market && csSettings.data.plugins.es.market.defaultSearch;
          // Apply defaults from settings
          if (defaultSearch) {
            angular.merge($scope.search, csSettings.data.plugins.es.market.defaultSearch);
          }
        }

        // Search on hash tag
        if (state.stateParams.hash) {
          if ($scope.search.text) {
            $scope.search.text = '#' + state.stateParams.hash + ' ' + $scope.search.text;
          }
          else {
            $scope.search.text = '#' + state.stateParams.hash;
          }
        }

        // Show closed ad
        if (state.stateParams.closed == true) {
          $scope.search.showClosed = true;
          showAdvanced = true;
        }
      }

      // Search on category
      if (state.stateParams && state.stateParams.category) {
        mkRecord.category.get({id: state.stateParams.category})
            .then(function (cat) {
              $scope.search.category = cat;
              return $scope.init();
            })
            .then(function() {
              return $scope.finishEnter(showAdvanced);
            });
      }
      else {
        $scope.init()
          .then(function() {
            return $scope.finishEnter(showAdvanced);
          });
      }
    }
  };
  $scope.$on('$ionicView.enter', $scope.enter);

  $scope.finishEnter = function(isAdvanced) {
    $scope.search.advanced = isAdvanced ? true : $scope.search.advanced; // keep null if first call
    if (isAdvanced || $scope.search.category || $scope.search.text) {
      $scope.doSearch()
          .then(function() {
            $scope.showFab('fab-add-market-record');
          });
    }
    else { // By default : get last record
      $scope.doGetLastRecord()
          .then(function() {
            $scope.showFab('fab-add-market-record');
          });
    }
    // removeIf(device)
    // Focus on search text (only if NOT device, to avoid keyboard opening)
    $focus('marketSearchText');

    // endRemoveIf(device)
    $scope.entered = true;
  };

  // Store some search options as settings defaults
  $scope.leave = function() {
    var dirty = false;

    csSettings.data.plugins.es.market = csSettings.data.plugins.es.market || {};
    csSettings.data.plugins.es.market.defaultSearch = csSettings.data.plugins.es.market.defaultSearch || {};

    // Check if location changed
    var location = $scope.search.location && $scope.search.location.trim();
    var oldLocation = csSettings.data.plugins.es.market.defaultSearch.location;
    if (!oldLocation || (oldLocation !== location)) {
      csSettings.data.plugins.es.market.defaultSearch = {
        location: location,
        geoPoint: location && $scope.search.geoPoint ? angular.copy($scope.search.geoPoint) : undefined
      };
      dirty = true;
    }

    // Check if distance changed
    var odlDistance = csSettings.data.plugins.es.geoDistance;
    if (!odlDistance || odlDistance !== $scope.search.geoDistance) {
      csSettings.data.plugins.es.geoDistance = $scope.search.geoDistance;
      dirty = true;
    }

    // execute with a delay, for better UI perf
    if (dirty) {
      $timeout(function() {
        csSettings.store();
      });
    }
  };
  $scope.$on('$ionicView.leave', function() {
    // WARN: do not set by reference
    // because it can be overrided by sub controller
    return $scope.leave();
  });

  /* -- manage events -- */

  $scope.onToggleAdvanced = function() {
    if ($scope.search.loading || !$scope.entered) return;

    // Options will be hide: reset options value
    if (!$scope.search.advanced) {
      $scope.search.showClosed = false;
      // Refresh results
      $scope.doRefresh();
    }
  };
  $scope.$watch('search.advanced', $scope.onToggleAdvanced, true);

  $scope.onCategoryClick = function(cat) {
    if (cat && cat.parent) {
      $scope.search.category = cat;
      $scope.options.category.show = true;
      $scope.search.showCategories=false; // hide categories
      $scope.doSearch();
    }
  };

  $scope.removeCategory = function() {
    $scope.search.category = null;
    $scope.category = null;
    $scope.doSearch();
  };

  $scope.removeLocation = function() {
    $scope.search.location = null;
    $scope.search.geoPoint = null;
    $scope.doSearch();
  };
}

function MkViewGalleryController($scope, csConfig, $q, $ionicScrollDelegate, $ionicSlideBoxDelegate, $ionicModal, $interval, mkRecord) {

  // Initialize the super class and extend it.
  $scope.zoomMin = 1;
  $scope.categories = [];
  $scope.pictures = [];
  $scope.activeSlide = 0;
  $scope.activeCategory = null;
  $scope.activeCategoryIndex = 0;
  $scope.started = false;

  $scope.options = $scope.options || angular.merge({
        category: {
          filter: undefined
        },
        slideDuration: 5000, // 5 sec
        showClosed: false
      }, csConfig.plugins && csConfig.plugins.market && csConfig.plugins.market.record || {});

  $scope.slideDurationLabels = {
    3000: {
      labelKey: 'MARKET.GALLERY.SLIDE_DURATION_OPTION',
      labelParams: {value: 3}
    },
    5000: {
      labelKey: 'MARKET.GALLERY.SLIDE_DURATION_OPTION',
      labelParams: {value: 5}
    },
    10000: {
      labelKey: 'MARKET.GALLERY.SLIDE_DURATION_OPTION',
      labelParams: {value: 10}
    },
    15000: {
      labelKey: 'MARKET.GALLERY.SLIDE_DURATION_OPTION',
      labelParams: {value: 15}
    },
    20000: {
      labelKey: 'MARKET.GALLERY.SLIDE_DURATION_OPTION',
      labelParams: {value: 20}
    }
  };
  $scope.slideDurations = _.keys($scope.slideDurationLabels);

  $scope.resetSlideShow = function() {
    delete $scope.activeCategory;
    delete $scope.activeCategoryIndex;
    delete $scope.activeSlide;
    delete $scope.categories;
  };

  $scope.startSlideShow = function(options) {


    // Already load: continue
    if ($scope.activeCategory && $scope.activeCategory.pictures && $scope.activeCategory.pictures.length) {
      return $scope.showPicturesModal($scope.activeCategoryIndex,$scope.activeSlide);
    }

    options = options || {};
    options.filter = options.filter || ($scope.options && $scope.options.category && $scope.options.category.filter);
    options.withStock = (!$scope.options || !$scope.options.showClosed);

    $scope.stop();

    $scope.loading = true;

    delete $scope.activeCategory;
    delete $scope.activeCategoryIndex;
    delete $scope.activeSlide;

    return mkRecord.category.stats(options)
        .then(function(res) {
          // Exclude empty categories
          $scope.categories = _.filter(res, function(cat) {
            return cat.count > 0 && cat.children && cat.children.length;
          });

          // Increment category
          return $scope.nextCategory();
        })
        .then(function() {
          $scope.loading = false;
        })
        .catch(function(err) {
          console.error(err);
          $scope.loading = false;
        })
      .then(function() {
        if ($scope.categories && $scope.categories.length) {
          return $scope.showPicturesModal(0,0);
        }
      });
  };

  $scope.showPicturesModal = function(catIndex, picIndex, pause) {
    $scope.activeCategoryIndex = catIndex;
    $scope.activeSlide = picIndex;

    $scope.activeCategory = $scope.categories[catIndex];

    if ($scope.modal) {
      $ionicSlideBoxDelegate.slide(picIndex);
      $ionicSlideBoxDelegate.update();
      return $scope.modal.show()
        .then(function() {
          if (!pause) {
            $scope.start();
          }
        });
    }

    return $ionicModal.fromTemplateUrl('plugins/market/templates/gallery/modal_slideshow.html',
        {
        scope: $scope
      })
      .then(function(modal) {
        $scope.modal = modal;
        $scope.modal.scope.closeModal = $scope.hidePictureModal;
        // Cleanup the modal when we're done with it!
        $scope.$on('$destroy', function() {
          if ($scope.modal) {
            $scope.modal.remove();
            delete $scope.modal;
          }
        });

        return $scope.modal.show()
          .then(function() {
            if (!pause) {
              $scope.start();
            }
          });
      });

  };

  $scope.hidePictureModal = function() {
    $scope.stop();
    if ($scope.modal && $scope.modal.isShown()) {
      return $scope.modal.hide();
    }
    return $q.when();
  };

  $scope.start = function() {
    if ($scope.interval) {
      $interval.cancel($scope.interval);
    }

    console.debug('[market] [gallery] Start slideshow');
    $scope.interval = $interval(function() {
      $scope.nextSlide();
    }, $scope.options.slideDuration);

  };

  $scope.stop = function() {
    if ($scope.interval) {
      console.debug('[market] [gallery] Stop slideshow');
      $interval.cancel($scope.interval);
      delete $scope.interval;
    }
  };

  /* -- manage slide box slider-- */

  $scope.nextCategory = function(started) {
    if (!$scope.categories || !$scope.categories.length) return $q.when();

    var started = started || !!$scope.interval;

    // Make sure sure to stop slideshow
    if (started && $scope.modal.isShown()) {
      return $scope.hidePictureModal()
        .then(function(){
          return $scope.nextCategory(started);
        });
    }

    $scope.activeCategoryIndex = $scope.loading ? 0 : $scope.activeCategoryIndex+1;

    // End of slideshow: restart (reload all)
    if ($scope.activeCategoryIndex == $scope.categories.length) {

      $scope.resetSlideShow();

      if (started) {
        return $scope.startSlideShow();
      }
      return $q.when()
    }

    var category = $scope.categories[$scope.activeCategoryIndex];

    // Load pictures
    return mkRecord.record.pictures({
        categories:  _.pluck(category.children, 'id'),
        size: 1000,
        withStock: (!$scope.options || !$scope.options.showClosed)
      })
      .then(function(pictures) {
        category.pictures = pictures;
        if (started) {
          return $scope.showPicturesModal($scope.activeCategoryIndex,0);
        }
      });
  };

  $scope.nextSlide = function() {

    // If end of category pictures
    if (!$scope.activeCategory || !$scope.activeCategory.pictures || !$scope.activeCategory.pictures.length || $ionicSlideBoxDelegate.currentIndex() == $scope.activeCategory.pictures.length-1) {
      $scope.nextCategory();
    }
    else {
      $ionicSlideBoxDelegate.next();
    }
  };

  $scope.updateSlideStatus = function(slide) {
    var zoomFactor = $ionicScrollDelegate.$getByHandle('scrollHandle' + slide).getScrollPosition().zoom;
    if (zoomFactor == $scope.zoomMin) {
      $ionicSlideBoxDelegate.enableSlide(true);
    } else {
      $ionicSlideBoxDelegate.enableSlide(false);
    }
  };

  $scope.isLoadedCategory = function(cat) {
    return cat.pictures && cat.pictures.length>0;
  };

  $scope.slideChanged = function(index) {
    $scope.activeSlide = index;
  }
}