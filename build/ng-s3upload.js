(function(window, document) {

// Create all modules and define dependencies to make sure they exist
// and are loaded in the correct order to satisfy dependency injection
// before all nested files are concatenated by Grunt

// Config
angular.module('ngS3upload.config', []).
  value('ngS3upload.config', {
      debug: true
  }).
  config(['$compileProvider', function($compileProvider){
    if (angular.isDefined($compileProvider.urlSanitizationWhitelist)) {
      $compileProvider.urlSanitizationWhitelist(/^\s*(https?|ftp|mailto|file|data):/);
    } else {
      $compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|ftp|mailto|file|data):/);
    }
  }]);

// Modules
angular.module('ngS3upload.directives', []);
angular.module('ngS3upload',
    [
        'ngS3upload.config',
        'ngS3upload.directives',
        'ngS3upload.services',
        'ngSanitize'
    ]);
angular.module('ngS3upload.config', []).
  constant('ngS3Config', {
    theme: 'bootstrap2'
  });angular.module('ngS3upload.services', []).
  service('S3Uploader', ['$http', '$q', '$window', function ($http, $q, $window) {
    this.uploads = 0;
    var self = this;

    this.getUploadOptions = function (uri) {
      var deferred = $q.defer();
      $http.get(uri).
        success(function (response, status) {
          deferred.resolve(response);
        }).error(function (error, status) {
          deferred.reject(error);
        });

      return deferred.promise;
    };

    this.randomString = function (length) {
      var chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      var result = '';
      for (var i = length; i > 0; --i) result += chars[Math.round(Math.random() * (chars.length - 1))];

      return result;
    };


    this.upload = function (scope, uri, key, acl, type, accessKey, policy, signature, file) {
      var deferred = $q.defer();
      scope.attempt = true;

      var fd = new FormData();
      fd.append('key', key);
      fd.append('acl', acl);
      fd.append('Content-Type', file.type);
      fd.append('AWSAccessKeyId', accessKey);
      fd.append('policy', policy);
      fd.append('signature', signature);
      fd.append("file", file);

      var xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", uploadProgress, false);
      xhr.addEventListener("load", uploadComplete, false);
      xhr.addEventListener("error", uploadFailed, false);
      xhr.addEventListener("abort", uploadCanceled, false);
      scope.$emit('s3upload:start', xhr);

      // Define event handlers
      function uploadProgress(e) {
        scope.$apply(function () {
          if (e.lengthComputable) {
            scope.progress = Math.round(e.loaded * 100 / e.total);
          } else {
            scope.progress = 'unable to compute';
          }
          var msg = {type: 'progress', value: scope.progress};
          scope.$emit('s3upload:progress', msg);
          if (typeof deferred.notify === 'function') {
            deferred.notify(msg);
          }

        });
      }
      function uploadComplete(e) {
        var xhr = e.srcElement || e.target;
        scope.$apply(function () {
          self.uploads--;
          scope.uploading = false;
          if (xhr.status === 204) { // successful upload
            scope.success = true;
            deferred.resolve(xhr);
            scope.$emit('s3upload:success', xhr, {path: uri + key});
          } else {
            scope.success = false;
            deferred.reject(xhr);
            scope.uploadName = null;
            scope.$emit('s3upload:error', xhr);
          }
        });
      }
      function uploadFailed(e) {
        var xhr = e.srcElement || e.target;
        scope.$apply(function () {
          self.uploads--;
          scope.uploading = false;
          scope.success = false;
          deferred.reject(xhr);
          scope.uploadName = null;
          scope.$emit('s3upload:error', xhr);
        });
      }
      function uploadCanceled(e) {
        var xhr = e.srcElement || e.target;
        scope.$apply(function () {
          self.uploads--;
          scope.uploading = false;
          scope.success = false;
          deferred.reject(xhr);
          scope.uploadName = null;
          scope.$emit('s3upload:abort', xhr);
        });
      }

      // Send the file
      scope.uploading = true;
      this.uploads++;
      xhr.open('POST', uri, true);
      xhr.send(fd);

      return deferred.promise;
    };

    this.isUploading = function () {
      return this.uploads > 0;
    };
  }]);
angular.module('ngS3upload.directives', []).
  directive('s3Upload', ['$parse', 'S3Uploader', 'ngS3Config', function ($parse, S3Uploader, ngS3Config) {
    return {
      restrict: 'AC',
      require: '?ngModel',
      replace: true,
      transclude: false,
      scope: true,
      controller: ['$scope', '$element', '$attrs', '$transclude', '$sce', function ($scope, $element, $attrs, $transclude, $sce) {
        $scope.attempt = false;
        $scope.success = false;
        $scope.uploading = false;

        $scope.barClass = function () {
          return {
            "progress-bar-success": $scope.attempt && !$scope.uploading && $scope.success
          };
        };

        $scope.trustUrl = function (filename) {
          return $sce.trustAsResourceUrl(filename);
        };

      }],
      compile: function (element, attr, linker) {
        return {
          pre: function ($scope, $element, $attr) {
            if (angular.isUndefined($attr.bucket)) {
              throw Error('bucket is a mandatory attribute');
            }
          },
          post: function (scope, element, attrs, ngModel) {
            // Build the opts array
            var opts = angular.extend({}, scope.$eval(attrs.s3UploadOptions || attrs.options));
            opts = angular.extend({
              submitOnChange: true,
              getOptionsUri: '/getS3Options',
              getManualOptions: null,
              acl: 'public-read',
              uploadingKey: 'uploading',
              maxFileSize: 10485760,
              folder: '',
              enableValidation: true,
              targetFilename: null

            }, opts);
            var bucket = scope.$eval(attrs.bucket);

            // Bind the button click event
            var button = angular.element(element.children()[0]),
              file = angular.element(element.find("input")[0]);
            button.bind('click', function (e) {
              file[0].click();
            });

            // Update the scope with the view value
            ngModel.$render = function () {
              scope.filename = ngModel.$viewValue;
            };

            // allowedTypes should be an object, nested in the form type -> array of formats
            // example:
            // { image: ['jpeg', 'gif'], video: [ 'avi' ] }
            // returns formats in the form that's understandable by the HTML5 accept attribute
            // example:
            // "image/jpeg, image/gif, video/avi"
            scope.acceptedFormats = function () {
              var formats = [];
              if (attrs.allowedtypes) {
                var allowedtypes = JSON.parse(attrs.allowedtypes);
                var types = Object.keys(allowedtypes);
                types.forEach(function(type) {
                  formats = formats.concat(allowedtypes[type].map( function(format) { return type + "/" + format; } ));
                });
              }
              return (formats.length > 0 ? formats.join(", ") : "*");
            };

            var uploadFile = function () {
              var selectedFile = file[0].files[0];
              var filename = selectedFile.name;
              var ext = filename.split('.').pop();

              if(angular.isObject(opts.getManualOptions)) {
                _upload(opts.getManualOptions);
              } else {
                S3Uploader.getUploadOptions(opts.getOptionsUri).then(function (s3Options) {
                  _upload(s3Options);
                }, function (error) {
                  throw Error("Can't receive the needed options for S3 " + error);
                });
              }

              function _upload(s3Options){
                if (selectedFile.size > opts.maxFileSize ) {
                  alert("File must be smaller than 10MB in size");
                  return;
                }

                if (opts.enableValidation) {
                  ngModel.$setValidity('uploading', false);
                }

                var s3Uri = 'https://' + bucket + '.s3.amazonaws.com/';
                var key = opts.targetFilename ? scope.$eval(opts.targetFilename) : opts.folder + (new Date()).getTime() + '-' + S3Uploader.randomString(16) + "." + ext;
                scope.uploadName = filename;
                S3Uploader.upload(scope,
                    s3Uri,
                    key,
                    opts.acl,
                    selectedFile.type,
                    s3Options.key,
                    s3Options.policy,
                    s3Options.signature,
                    selectedFile
                  ).then(function () {
                    ngModel.$setViewValue(s3Uri + key);
                    scope.filename = ngModel.$viewValue;
                    scope.filetype = selectedFile.type.split("/")[0];

                    if (opts.enableValidation) {
                      ngModel.$setValidity('uploading', true);
                      ngModel.$setValidity('succeeded', true);
                      scope.$emit('s3upload:uploaded', scope.filename, scope.filetype);
                      scope.progress = 0;
                    }
                  }, function () {
                    scope.filename = ngModel.$viewValue;

                    if (opts.enableValidation) {
                      ngModel.$setValidity('uploading', true);
                      ngModel.$setValidity('succeeded', false);
                    }
                  });
              }
            };

            element.bind('change', function (nVal) {
              if (opts.submitOnChange) {
                scope.$apply(function () {
                  uploadFile();
                });
              }
            });

            if (angular.isDefined(attrs.doUpload)) {
              scope.$watch(attrs.doUpload, function(value) {
                if (value) uploadFile();
              });
            }
          }
        };
      },
      templateUrl: function(elm, attrs) {
        var theme = attrs.theme || ngS3Config.theme;
        return 'theme/' + theme + '.html';
      }
    };
  }]);
angular.module('ngS3upload').run(['$templateCache', function($templateCache) {
  'use strict';

  $templateCache.put('theme/bootstrap2.html',
    "<div class=\"upload-wrap\">\n" +
    "  <button class=\"btn btn-primary\" type=\"button\"><span ng-if=\"!filename\">Choose file</span><span ng-if=\"filename\">Replace file</span></button>\n" +
    "  <a ng-href=\"{{ filename  }}\" target=\"_blank\" class=\"\" ng-if=\"filename\" > Stored file </a>\n" +
    "  <div class=\"progress progress-striped\" ng-class=\"{active: uploading}\" ng-show=\"attempt\" style=\"margin-top: 10px\">\n" +
    "    <div class=\"bar\" style=\"width: {{ progress }}%;\" ng-class=\"barClass()\"></div>\n" +
    "    </div>\n" +
    "  <input type=\"file\" style=\"display: none\"/>\n" +
    "</div>\n"
  );


  $templateCache.put('theme/bootstrap3.html',
    "<div class=\"upload-wrap\">\n" +
    "  <button class=\"btn btn-primary\" type=\"button\"><span ng-if=\"!filename\">Choose file</span><span ng-if=\"filename\">Replace file</span></button>\n" +
    "  <div class=\"progress\">\n" +
    "    <div class=\"progress-bar progress-bar-striped\" ng-class=\"{active: uploading}\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" style=\"width: {{ progress }}%; margin-top: 10px\" ng-class=\"barClass()\">\n" +
    "      <span class=\"sr-only\">{{progress}}% Complete</span>\n" +
    "    </div>\n" +
    "  </div>\n" +
    "  <input type=\"file\" style=\"display: none\"/>\n" +
    "</div>\n"
  );


  $templateCache.put('theme/multi.html',
    "<div>\n" +
    "  <button ng-show=\"!uploading\" class=\"btn btn-primary upload-btn\" type=\"button\">\n" +
    "    <span>Upload Image / Video</span>\n" +
    "    <i class=\"fa fa-cloud-upload\"></i>\n" +
    "  </button>\n" +
    "  <div ng-if=\"uploading\" class=\"progress-card\">\n" +
    "    <div class=\"filename\">{{ uploadName }}</div>\n" +
    "    <div class=\"progress\">\n" +
    "      <div class=\"progress-bar progress-bar-striped\" ng-class=\"{active: uploading}\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" style=\"width: {{ progress }}%;\" ng-class=\"barClass()\">\n" +
    "        <span class=\"sr-only\">{{progress}}% Complete</span>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </div>\n" +
    "  <input type=\"file\" accept=\"{{acceptedFormats()}}\" style=\"display: none\"/>\n" +
    "</div>\n"
  );

}]);
})(window, document);